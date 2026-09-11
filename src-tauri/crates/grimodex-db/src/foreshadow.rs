//! Foreshadow (伏線) の DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/foreshadow.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `plot_threads` と同じ構図)。SQL・検証・
//! エラー文字列・Option<Option<T>> patch の 3 値挙動は移動前と完全に同一。
//!
//! Renderer の manual writer はこの module の既存 SQL/OCC 境界を維持しつつ、
//! domain mutation・canonical Change Event・Narrative Change Feed を同じ transaction
//! で確定する。Agent 側の tracked writer は引き続き `agent_writes` が所有する。

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::{
    idempotency::{
        insert_idempotent_response, load_idempotent_response, load_row, payload_fingerprint,
        run_atomic_create, IdempotencyRequest,
    },
    Database,
};
use crate::agent_writes::{
    canonical_payload_with_authority_context, validate_agent_field_authority_for_entity,
    validate_renderer_authority_context_for_routes, RendererCanonicalWriteContext,
};
use crate::change_events::AppendChangeEvent;
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    require_typed_inverse_lineage_in_project, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};

type PayoffRootState = (Option<String>, Option<i64>, Option<i64>, i64);
type PayoffUpdateState = (String, Option<String>, Option<i64>, Option<i64>, i64);

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererWriteContext {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
}

#[derive(Clone, Debug)]
struct ResolvedWriteContext {
    request_id: String,
    session_id: String,
    event_uid: String,
    cause_kind: NarrativeChangeCauseKind,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<String>,
    undo_journal_id: Option<String>,
}

fn resolve_write_context(
    operation: &str,
    context: &RendererWriteContext,
) -> anyhow::Result<ResolvedWriteContext> {
    for (field, value) in [
        ("requestId", context.request_id.as_str()),
        ("sessionId", context.session_id.as_str()),
        ("eventUid", context.event_uid.as_str()),
    ] {
        anyhow::ensure!(
            !value.trim().is_empty(),
            "{operation} {field} must be non-empty"
        );
    }
    let cause_kind = match context.origin {
        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
        _ => NarrativeChangeCauseKind::Forward,
    };
    match cause_kind {
        NarrativeChangeCauseKind::Forward => anyhow::ensure!(
            context.original_transaction_id.is_none(),
            "{operation} forward mutation cannot name originalTransactionId"
        ),
        NarrativeChangeCauseKind::Undo | NarrativeChangeCauseKind::Redo => anyhow::ensure!(
            context
                .original_transaction_id
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty()),
            "{operation} undo/redo mutation requires originalTransactionId"
        ),
    }
    Ok(ResolvedWriteContext {
        request_id: context.request_id.clone(),
        session_id: context.session_id.clone(),
        event_uid: context.event_uid.clone(),
        cause_kind,
        origin: context.origin,
        original_transaction_id: context.original_transaction_id.clone(),
        undo_journal_id: context.undo_journal_id.clone(),
    })
}

fn validate_foreshadow_renderer_context(
    operation: &str,
    payload_context: &RendererWriteContext,
    renderer_context: &RendererCanonicalWriteContext,
    allowed_routes: &[&str],
) -> anyhow::Result<()> {
    validate_renderer_authority_context_for_routes(renderer_context, allowed_routes)?;
    anyhow::ensure!(
        renderer_context.request_id == payload_context.request_id,
        "{operation} requestId does not match canonical authority context"
    );
    anyhow::ensure!(
        renderer_context.event_uid == payload_context.event_uid,
        "{operation} eventUid does not match canonical authority context"
    );
    anyhow::ensure!(
        renderer_context.origin == payload_context.origin,
        "{operation} origin does not match canonical authority context"
    );
    anyhow::ensure!(
        renderer_context.original_transaction_id == payload_context.original_transaction_id,
        "{operation} originalTransactionId does not match canonical authority context"
    );
    anyhow::ensure!(
        renderer_context.undo_journal_id == payload_context.undo_journal_id,
        "{operation} undoJournalId does not match canonical authority context"
    );
    Ok(())
}

fn surface_for_origin(origin: NarrativeChangeOrigin) -> &'static str {
    match origin {
        NarrativeChangeOrigin::Human => "manual",
        NarrativeChangeOrigin::AiApply => "ai-apply",
        NarrativeChangeOrigin::Import => "import",
        NarrativeChangeOrigin::Restore => "restore",
        NarrativeChangeOrigin::Migration => "migration",
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo => "history",
    }
}

#[cfg(test)]
impl Default for RendererWriteContext {
    fn default() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            request_id: format!("foreshadow-internal-request-{id}"),
            session_id: "foreshadow-internal-session".to_string(),
            event_uid: format!("foreshadow-internal-event-{id}"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
        }
    }
}

fn attach_maintenance_transaction_id(mut response: Value, transaction_id: String) -> Value {
    if let Value::Object(row) = &mut response {
        row.insert(
            "maintenanceTransactionId".to_string(),
            Value::String(transaction_id),
        );
    }
    response
}

fn run_atomic_foreshadow_mutation<Mutate>(
    db: &Database,
    request: IdempotencyRequest<'_>,
    project_id: &str,
    mutate: Mutate,
) -> anyhow::Result<Value>
where
    Mutate: FnOnce(&Connection) -> anyhow::Result<Value>,
{
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(response) = load_idempotent_response(conn, &request)? {
                return Ok(response);
            }
            let response = mutate(conn)?;
            insert_idempotent_response(conn, &request, project_id, &response)?;
            Ok(response)
        })();
        match result {
            Ok(value) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(value),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn json_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn foreshadow_row_version(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_object)
        .and_then(|row| row.get("version"))
        .and_then(Value::as_i64)
}

fn foreshadow_state_digest(value: Option<&Value>) -> anyhow::Result<Option<String>> {
    value.map(narrative_snapshot_digest).transpose()
}

fn foreshadow_root_feed_event(
    foreshadow_id: &str,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    mut changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    changed_paths.sort();
    changed_paths.dedup();
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": "foreshadow",
            "foreshadowId": foreshadow_id,
        }),
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: foreshadow_row_version(before),
        before_digest: foreshadow_state_digest(before)?,
        after_version: foreshadow_row_version(after),
        after_digest: foreshadow_state_digest(after)?,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
        changed_paths,
        text_impact: None,
    })
}

struct ForeshadowFeedAppend<'a> {
    project_id: &'a str,
    operation: &'a str,
    entity_id: &'a str,
    context: &'a ResolvedWriteContext,
    undo_journal_id: Option<String>,
    events: Vec<NarrativeChangeEventInput>,
}

fn normalize_foreshadow_feed_events_in_tx(
    conn: &Connection,
    project_id: &str,
    events: &mut [NarrativeChangeEventInput],
) -> anyhow::Result<()> {
    // Child-anchor writers mutate the aggregate but historically built their
    // receipt from the compact root row.  The Feed root is the full canonical
    // aggregate, so normalize every Foreshadow event at this last writer
    // boundary.  Using the existing Feed head for `before` also keeps a
    // create/delete/restore sequence continuous across all writer families.
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
            event.after_version = snapshot.get("version").and_then(Value::as_i64);
            event.after_digest = Some(narrative_snapshot_digest(&snapshot)?);
        } else if event.mutation_kind == "delete" {
            event.after_version = None;
            event.after_digest = None;
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

fn append_foreshadow_feed_with_authority(
    conn: &Connection,
    input: ForeshadowFeedAppend<'_>,
    renderer_context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<String> {
    if let Some(original_transaction_id) = input.context.original_transaction_id.as_deref() {
        require_typed_inverse_lineage_in_project(
            conn,
            input.project_id,
            original_transaction_id,
            "foreshadow",
            input.entity_id,
        )?;
    }
    let timestamp = chrono::Utc::now().timestamp_millis();
    let occurred_at = chrono::DateTime::from_timestamp_millis(timestamp)
        .ok_or_else(|| {
            anyhow::anyhow!("foreshadow writer timestamp is outside the supported range")
        })?
        .to_rfc3339();
    let mut events = input.events;
    normalize_foreshadow_feed_events_in_tx(conn, input.project_id, &mut events)?;
    let base_payload = serde_json::to_string(&json!({
        "requestId": input.context.request_id,
        "origin": input.context.origin,
    }))?;
    let canonical_payload = renderer_context.map_or(base_payload.clone(), |context| {
        canonical_payload_with_authority_context(&base_payload, context)
    });
    let canonical = AppendChangeEvent {
        event_uid: input.context.event_uid.clone(),
        scene_id: None,
        domain: "foreshadow".to_string(),
        op_type: input.operation.to_string(),
        entity_type: Some("foreshadow".to_string()),
        entity_id: Some(input.entity_id.to_string()),
        payload: canonical_payload,
        timestamp,
    };
    let result = append_canonical_and_narrative_change_in_tx(
        conn,
        input.project_id,
        &input.context.session_id,
        &canonical,
        &AppendNarrativeChangeTransactionInput {
            project_id: input.project_id.to_string(),
            request_id: input.context.request_id.clone(),
            source_domain: input.operation.to_string(),
            source_change_event_uid: input.context.event_uid.clone(),
            cause_kind: input.context.cause_kind,
            origin: input.context.origin,
            original_transaction_id: input.context.original_transaction_id.clone(),
            commit_id: None,
            journal_id: None,
            undo_journal_id: input.undo_journal_id,
            application_ids: Vec::new(),
            occurred_at,
            events,
        },
    )?;
    Ok(result.narrative.transaction_id)
}

pub(crate) fn setup_semantic_key(
    foreshadow_id: &str,
    scene_id: &str,
    from_pos: i64,
    to_pos: i64,
) -> String {
    format!("{foreshadow_id}|{scene_id}|{from_pos}|{to_pos}")
}

pub(crate) fn setup_semantic_key_for_upsert(
    setup_id: &str,
    foreshadow_id: &str,
    scene_id: &str,
    from_pos: i64,
    to_pos: i64,
    existing_semantic_key: Option<&str>,
) -> String {
    let natural_key = setup_semantic_key(foreshadow_id, scene_id, from_pos, to_pos);
    let legacy_duplicate_key = format!("{natural_key}#dup:{setup_id}");
    if existing_semantic_key == Some(legacy_duplicate_key.as_str()) {
        legacy_duplicate_key
    } else {
        natural_key
    }
}

fn with_immediate_transaction<T>(
    db: &Database,
    operation: impl FnOnce(&Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = operation(conn);
        match result {
            Ok(value) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(value),
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn load_foreshadow_row_in_tx(conn: &Connection, id: &str) -> anyhow::Result<Value> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id.to_string())],
        "get",
    )?;
    Ok(rows
        .into_iter()
        .next()
        .map(Value::Object)
        .unwrap_or(Value::Null))
}

fn load_canonical_foreshadow_snapshot_in_tx(
    conn: &Connection,
    project_id: &str,
    id: &str,
) -> anyhow::Result<Value> {
    crate::canonical_feed_snapshots::canonical_foreshadow_snapshot(conn, project_id, id)
}

/// Publish a child aggregate mutation through the root OCC token. The caller
/// holds BEGIN IMMEDIATE, so the read + CAS increment is atomic. Pure no-ops
/// return the unchanged authoritative row without advancing the token.
pub(crate) fn finish_foreshadow_child_write(
    conn: &Connection,
    foreshadow_id: &str,
    changed: bool,
    expected_base_version: Option<i64>,
    now: i64,
) -> anyhow::Result<Value> {
    if changed {
        let current_version: i64 = conn.query_row(
            "SELECT version FROM foreshadows WHERE id = ?1",
            params![foreshadow_id],
            |row| row.get(0),
        )?;
        if let Some(expected) = expected_base_version {
            anyhow::ensure!(
                current_version == expected,
                "FORESHADOW_VERSION_MISMATCH: expected version {expected}, found {current_version}"
            );
        }
        let next_version = current_version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("foreshadow version overflow"))?;
        let updated = conn.execute(
            "UPDATE foreshadows
                SET version = ?1, updated_at = ?2
              WHERE id = ?3 AND version = ?4",
            params![next_version, now, foreshadow_id, current_version],
        )?;
        anyhow::ensure!(
            updated == 1,
            "FORESHADOW_VERSION_MISMATCH: expected version {current_version}"
        );
    }
    load_foreshadow_row_in_tx(conn, foreshadow_id)
}

fn validate_setup_anchor_ownership(
    conn: &Connection,
    foreshadow_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let projects: Option<(String, String)> = conn
        .query_row(
            "SELECT f.project_id, scene.project_id
               FROM foreshadows f
               JOIN tree_nodes scene ON scene.id = ?2 AND scene.node_type = 'scene'
              WHERE f.id = ?1",
            params![foreshadow_id, scene_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match projects {
        Some((foreshadow_project_id, scene_project_id))
            if foreshadow_project_id == scene_project_id =>
        {
            Ok(())
        }
        Some(_) => anyhow::bail!("foreshadow setup anchor must belong to the same project"),
        None => anyhow::bail!(
            "foreshadow setup anchor must reference an existing foreshadow and scene in the same project"
        ),
    }
}

// ─────────────────────────── DTO ───────────────────────────

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowCreatePayload {
    /// Entity id. Legacy callers also use this as the request key.
    #[serde(default)]
    id: Option<String>,
    /// Domain-owned idempotency key supplied by the renderer. A deliberate
    /// history restore keeps the entity id but uses a fresh request id, while
    /// a retry of an uncertain create reuses both.
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    title: String,
    #[serde(default)]
    intent: Option<String>,
    #[serde(default)]
    notes: Option<String>,
    #[serde(default)]
    payoff_scene_id: Option<String>,
    #[serde(default)]
    payoff_from_pos: Option<i64>,
    #[serde(default)]
    payoff_to_pos: Option<i64>,
    #[serde(default)]
    payoff_confirmed: bool,
    #[serde(default)]
    abandoned: bool,
    #[serde(default = "default_secret")]
    secret: bool,
    #[serde(default)]
    load_bearing: Option<String>,
    #[serde(default)]
    codex_link_dirty_at: Option<i64>,
}

fn deserialize_present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowPatch {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    base_version: i64,
    title: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    intent: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    notes: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    payoff_scene_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    payoff_from_pos: Option<Option<i64>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    payoff_to_pos: Option<Option<i64>>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
    secret: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    load_bearing: Option<Option<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanResolvePayload {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    setup_id: String,
    base_version: i64,
    action: String,
    scene_id: Option<String>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAnchorInput {
    id: String,
    foreshadow_id: String,
    base_version: i64,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayoffAnchorInput {
    foreshadow_id: String,
    base_version: i64,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnchorMarkOutput {
    from: i64,
    to: i64,
    mark_name: String,
    attrs: Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSetupPatch {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    base_version: i64,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    strength: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    ai_strength: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    ai_reasoning: Option<Option<String>>,
    is_orphan: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    last_evaluated_at: Option<Option<i64>>,
}

/// `foreshadow_setup_create_ai` の 12 引数を束ねた DTO。Tauri コマンドは従来
/// どおり 12 個の flat 引数で受けてこの struct を組み立て、napi は FE が送る
/// camelCase オブジェクトを `from_wire` でこの struct に落とす（両者とも同一
/// serde 経路）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupCreateAiInput {
    #[serde(flatten)]
    pub context: RendererWriteContext,
    pub project_id: String,
    pub id: String,
    pub foreshadow_id: String,
    pub base_version: i64,
    pub scene_id: String,
    pub from_pos: i64,
    pub to_pos: i64,
    pub kind: String,
    pub strength: Option<String>,
    pub ai_strength: Option<String>,
    pub attribution: String,
    pub ai_rationale: Option<String>,
    pub ai_reasoning: Option<String>,
    pub last_evaluated_at: Option<i64>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowDeletePayload {
    pub id: String,
    pub project_id: String,
    pub base_version: i64,
    #[serde(flatten)]
    pub context: RendererWriteContext,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowCodexLinkPayload {
    pub foreshadow_id: String,
    pub codex_id: String,
    pub project_id: String,
    pub base_version: i64,
    #[serde(flatten)]
    pub context: RendererWriteContext,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSetupStrengthPayload {
    pub setup_id: String,
    pub strength: Option<String>,
    pub project_id: String,
    pub base_version: i64,
    #[serde(flatten)]
    pub context: RendererWriteContext,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowAnchorSavePayload {
    pub scene_id: String,
    pub project_id: String,
    pub setups: Vec<SetupAnchorInput>,
    pub payoffs: Vec<PayoffAnchorInput>,
    pub base_versions: HashMap<String, i64>,
    pub doc_content_size: i64,
    #[serde(flatten)]
    pub context: RendererWriteContext,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowListWithLabelsResponse {
    foreshadows: Vec<Value>,
    setups: Vec<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSceneInfoResponse {
    setup_foreshadow_ids: Vec<String>,
    payoff_foreshadow_ids: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowSceneContextResponse {
    setups: Vec<Value>,
    payoffs: Vec<Value>,
    setup_scene_rows: Vec<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeshadowChapterStatsBundle {
    scenes: Vec<Value>,
    setups_on_scenes: Vec<Value>,
    payoff_foreshadows: Vec<Value>,
    related_foreshadows: Vec<Value>,
    related_setups: Vec<Value>,
}

// ─────────────────────────── ヘルパー ───────────────────────────

/// `load_bearing` 列に許される値。`deriveLabel.ts` の判定軸と一致。
/// 不明値は `deriveLabel` で silently `needs_strengthening` に落ちるため、
/// データ整合性確保のため Rust 境界で厳格に弾く。
fn validate_load_bearing(value: Option<&str>) -> anyhow::Result<()> {
    match value {
        None | Some("critical") | Some("supporting") | Some("optional") => Ok(()),
        Some(other) => Err(anyhow::anyhow!(
            "invalid load_bearing value: {:?} (expected one of: critical, supporting, optional, null)",
            other
        )),
    }
}

fn default_secret() -> bool {
    true
}

pub(crate) fn record_manual_foreshadow_fields(
    conn: &Connection,
    project_id: &str,
    foreshadow_id: &str,
    field_paths: &[&str],
    updated_at: i64,
) -> anyhow::Result<()> {
    let updated_at = updated_at.to_string();
    crate::narrative_extraction::record_human_field_write(
        conn,
        project_id,
        "foreshadow",
        foreshadow_id,
        field_paths,
        &updated_at,
    )
}

const FORESHADOW_AUTHORITY_FIELDS: &[&str] = &[
    "/title",
    "/intent",
    "/notes",
    "/payoffSceneId",
    "/payoffFromPos",
    "/payoffToPos",
    "/payoffConfirmed",
    "/abandoned",
    "/secret",
    "/loadBearing",
    "/setups",
    "/payoffs",
    "/codexEntryIds",
];

fn validate_payoff_anchor(
    scene_id: Option<&str>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
) -> anyhow::Result<()> {
    match (scene_id, from_pos, to_pos) {
        (None, None, None) | (Some(_), None, None) => Ok(()),
        (Some(_), Some(from), Some(to)) if 0 <= from && from <= to => Ok(()),
        (None, _, _) => Err(anyhow::anyhow!(
            "foreshadow payoff positions require a payoff scene"
        )),
        (Some(_), _, _) => Err(anyhow::anyhow!(
            "foreshadow payoff positions must both be null or satisfy 0 <= from <= to"
        )),
    }
}

fn validate_payoff_scene_ownership(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let scene_project_id: Option<String> = conn
        .query_row(
            "SELECT project_id FROM tree_nodes
              WHERE id = ?1 AND node_type = 'scene'",
            params![scene_id],
            |row| row.get(0),
        )
        .optional()?;
    anyhow::ensure!(
        scene_project_id.as_deref() == Some(project_id),
        "foreshadow payoff scene must reference an existing same project scene"
    );
    Ok(())
}

fn in_placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn fetch_setup_label_rows(db: &Database, foreshadow_ids: &[String]) -> anyhow::Result<Vec<Value>> {
    if foreshadow_ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders = in_placeholders(foreshadow_ids.len());
    let params: Vec<Value> = foreshadow_ids.iter().cloned().map(Value::String).collect();
    let setup_rows = db.execute(
        &format!(
            "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning \
             FROM foreshadow_setups WHERE foreshadow_id IN ({placeholders})"
        ),
        &params,
        "all",
    )?;
    Ok(setup_rows.into_iter().map(Value::Object).collect())
}

// ─────────────────────────── foreshadow CRUD ───────────────────────────

pub fn create(db: &Database, payload: ForeshadowCreatePayload) -> anyhow::Result<Value> {
    create_with_renderer_authority(db, payload, None)
}

pub fn create_with_renderer_authority(
    db: &Database,
    payload: ForeshadowCreatePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("foreshadow.create", &payload.context)?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &["human-direct", "history-replay", "restore-or-migration"],
        )?;
        anyhow::ensure!(
            context.request_id == payload.context.request_id,
            "foreshadow create requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == payload.context.event_uid,
            "foreshadow create eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == payload.context.origin,
            "foreshadow create origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == payload.context.original_transaction_id,
            "foreshadow create originalTransactionId does not match canonical authority context"
        );
    }
    // The request id selects the ledger entry and is therefore not semantic
    // payload. Excluding it lets undo/redo deliberately restore the same entity
    // under a fresh request without weakening same-request conflict detection.
    let fingerprint_payload = serde_json::json!({
        "id": payload.id,
        "projectId": payload.project_id,
        "title": payload.title,
        "intent": payload.intent,
        "notes": payload.notes,
        "payoffSceneId": payload.payoff_scene_id,
        "payoffFromPos": payload.payoff_from_pos,
        "payoffToPos": payload.payoff_to_pos,
        "payoffConfirmed": payload.payoff_confirmed,
        "abandoned": payload.abandoned,
        "secret": payload.secret,
        "loadBearing": payload.load_bearing,
        "codexLinkDirtyAt": payload.codex_link_dirty_at,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow_create", &fingerprint_payload)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = payload
        .id
        .unwrap_or_else(|| write_context.request_id.clone());
    let project_id = payload.project_id;
    let title = payload.title;
    let intent = payload.intent;
    let notes = payload.notes;
    let payoff_scene_id = payload.payoff_scene_id;
    let payoff_from_pos = payload.payoff_from_pos;
    let payoff_to_pos = payload.payoff_to_pos;
    let payoff_confirmed = payload.payoff_confirmed;
    let abandoned = payload.abandoned;
    let secret = payload.secret;
    let load_bearing = payload.load_bearing;
    let codex_link_dirty_at = payload.codex_link_dirty_at;
    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "foreshadow_create",
            request_id: Some(write_context.request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            validate_load_bearing(load_bearing.as_deref())?;
            validate_payoff_anchor(
                payoff_scene_id.as_deref(),
                payoff_from_pos,
                payoff_to_pos,
            )?;
            if let Some(scene_id) = payoff_scene_id.as_deref() {
                validate_payoff_scene_ownership(conn, &project_id, scene_id)?;
            }
            Database::execute_with_conn(
                conn,
                "INSERT INTO foreshadows
                 (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing, codex_link_dirty_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                &[
                    Value::String(id.clone()),
                    Value::String(project_id.clone()),
                    Value::String(title.clone()),
                    intent.clone().map(Value::String).unwrap_or(Value::Null),
                    notes.clone().map(Value::String).unwrap_or(Value::Null),
                    payoff_scene_id
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    payoff_from_pos
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null),
                    payoff_to_pos
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null),
                    Value::Bool(payoff_confirmed),
                    Value::Bool(abandoned),
                    Value::Bool(secret),
                    load_bearing
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    codex_link_dirty_at
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null),
                    Value::Number(now.into()),
                    Value::Number(now.into()),
                ],
                "run",
            )
            .or_else(|error| {
                let existing = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM foreshadows WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                let Some(row) = existing.first() else {
                    return Err(error);
                };
                let matches = row.get("project_id").and_then(Value::as_str)
                    == Some(project_id.as_str())
                    && row.get("title").and_then(Value::as_str) == Some(title.as_str())
                    && row.get("intent")
                        == Some(&intent.clone().map(Value::String).unwrap_or(Value::Null))
                    && row.get("notes")
                        == Some(&notes.clone().map(Value::String).unwrap_or(Value::Null))
                    && row.get("payoff_scene_id")
                        == Some(
                            &payoff_scene_id
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        )
                    && row.get("payoff_from_pos")
                        == Some(
                            &payoff_from_pos
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        )
                    && row.get("payoff_to_pos")
                        == Some(
                            &payoff_to_pos
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        )
                    && row.get("payoff_confirmed").and_then(Value::as_i64)
                        == Some(i64::from(payoff_confirmed))
                    && row.get("abandoned").and_then(Value::as_i64)
                        == Some(i64::from(abandoned))
                    && row.get("secret").and_then(Value::as_i64)
                        == Some(i64::from(secret))
                    && row.get("load_bearing")
                        == Some(
                            &load_bearing
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        )
                    && row.get("codex_link_dirty_at")
                        == Some(
                            &codex_link_dirty_at
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        );
                if matches {
                    Ok(Vec::new())
                } else {
                    Err(anyhow::anyhow!(
                        "FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT: request id reused with different payload"
                    ))
                }
            })?;
            let rows = Database::execute_with_conn(
                conn,
                "SELECT * FROM foreshadows WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?;
            let row = rows
                .first()
                .cloned()
                .map(Value::Object)
                .ok_or_else(|| {
                    anyhow::anyhow!("foreshadow create completed without a persisted row")
                })?;
            let feed_row = load_canonical_foreshadow_snapshot_in_tx(conn, &project_id, &id)?;
            record_manual_foreshadow_fields(
                conn,
                &project_id,
                &id,
                FORESHADOW_AUTHORITY_FIELDS,
                now,
            )?;
            let transaction_id = append_foreshadow_feed_with_authority(
                conn,
                ForeshadowFeedAppend {
                    project_id: &project_id,
                    operation: "foreshadow.create",
                    entity_id: &id,
                    context: &write_context,
                    undo_journal_id: None,
                    events: vec![foreshadow_root_feed_event(
                        &id,
                        "catalog",
                        "create",
                        None,
                        Some(&feed_row),
                        vec!["/".to_string()],
                    )?],
                },
                renderer_context.as_ref(),
            )?;
            Ok((
                project_id.clone(),
                attach_maintenance_transaction_id(row, transaction_id),
            ))
        },
        |conn| load_row(conn, "foreshadows", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn update(db: &Database, id: String, patch: ForeshadowPatch) -> anyhow::Result<Value> {
    update_with_renderer_authority(db, id, patch, None)
}

pub fn update_with_renderer_authority(
    db: &Database,
    id: String,
    patch: ForeshadowPatch,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        patch.base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    let write_context = resolve_write_context("foreshadow.update", &patch.context)?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &["human-direct", "history-replay", "restore-or-migration"],
        )?;
        anyhow::ensure!(
            context.request_id == patch.context.request_id,
            "foreshadow update requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == patch.context.event_uid,
            "foreshadow update eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == patch.context.origin,
            "foreshadow update origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == patch.context.original_transaction_id,
            "foreshadow update originalTransactionId does not match canonical authority context"
        );
    }
    let requested_project_id = patch.project_id.clone();
    let fingerprint_payload = json!({
        "id": id,
        "projectId": requested_project_id,
        "baseVersion": patch.base_version,
        "title": patch.title,
        "intent": patch.intent,
        "notes": patch.notes,
        "payoffSceneId": patch.payoff_scene_id,
        "payoffFromPos": patch.payoff_from_pos,
        "payoffToPos": patch.payoff_to_pos,
        "payoffConfirmed": patch.payoff_confirmed,
        "abandoned": patch.abandoned,
        "secret": patch.secret,
        "loadBearing": patch.load_bearing,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow_update", &fingerprint_payload)?;
    let base_version = patch.base_version;
    let changed_paths = [
        patch.title.is_some().then_some("/title"),
        patch.intent.is_some().then_some("/intent"),
        patch.notes.is_some().then_some("/notes"),
        patch.payoff_scene_id.is_some().then_some("/payoff/sceneId"),
        patch.payoff_from_pos.is_some().then_some("/payoff/fromPos"),
        patch.payoff_to_pos.is_some().then_some("/payoff/toPos"),
        patch
            .payoff_confirmed
            .is_some()
            .then_some("/payoff/confirmed"),
        patch.abandoned.is_some().then_some("/abandoned"),
        patch.secret.is_some().then_some("/secret"),
        patch.load_bearing.is_some().then_some("/loadBearing"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if let Some(ref lb) = patch.load_bearing {
        validate_load_bearing(lb.as_deref())?;
    }
    let payoff_scene_patch = patch.payoff_scene_id.clone();
    let payoff_from_patch = patch.payoff_from_pos;
    let payoff_to_patch = patch.payoff_to_pos;
    let now = chrono::Utc::now().timestamp_millis();
    let writes_forward_journal = write_context.cause_kind == NarrativeChangeCauseKind::Forward;
    let undo_journal_id = write_context
        .undo_journal_id
        .clone()
        .or_else(|| writes_forward_journal.then(|| write_context.request_id.clone()));
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();

    if let Some(title) = patch.title {
        sets.push("title = ?");
        params.push(Value::String(title));
    }
    if let Some(intent) = patch.intent {
        sets.push("intent = ?");
        params.push(intent.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(notes) = patch.notes {
        sets.push("notes = ?");
        params.push(notes.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(payoff_scene_id) = patch.payoff_scene_id {
        sets.push("payoff_scene_id = ?");
        params.push(payoff_scene_id.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(payoff_from_pos) = patch.payoff_from_pos {
        sets.push("payoff_from_pos = ?");
        params.push(
            payoff_from_pos
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
        );
    }
    if let Some(payoff_to_pos) = patch.payoff_to_pos {
        sets.push("payoff_to_pos = ?");
        params.push(
            payoff_to_pos
                .map(|v| Value::Number(v.into()))
                .unwrap_or(Value::Null),
        );
    }
    if let Some(payoff_confirmed) = patch.payoff_confirmed {
        sets.push("payoff_confirmed = ?");
        params.push(Value::Bool(payoff_confirmed));
    }
    if let Some(abandoned) = patch.abandoned {
        sets.push("abandoned = ?");
        params.push(Value::Bool(abandoned));
    }
    if let Some(secret) = patch.secret {
        sets.push("secret = ?");
        params.push(Value::Bool(secret));
    }
    if let Some(load_bearing) = patch.load_bearing {
        sets.push("load_bearing = ?");
        params.push(load_bearing.map(Value::String).unwrap_or(Value::Null));
    }

    if sets.is_empty() {
        return run_atomic_foreshadow_mutation(
            db,
            IdempotencyRequest {
                domain: "foreshadow_update",
                request_id: Some(&write_context.request_id),
                payload_hash: &payload_hash,
                conflict_marker: "FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT",
            },
            &requested_project_id,
            |conn| {
                let rows = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM foreshadows WHERE id = ? AND project_id = ? AND version = ?",
                    &[
                        Value::String(id.clone()),
                        Value::String(requested_project_id.clone()),
                        Value::Number(base_version.into()),
                    ],
                    "get",
                )?;
                anyhow::ensure!(
                    !rows.is_empty(),
                    "FORESHADOW_VERSION_MISMATCH: row missing or expected version {base_version} is stale"
                );
                Ok(Value::Object(rows[0].clone()))
            },
        );
    }

    sets.push("version = version + 1");
    sets.push("updated_at = ?");
    params.push(Value::Number(now.into()));
    params.push(Value::String(id.clone()));
    params.push(Value::String(requested_project_id.clone()));
    params.push(Value::Number(base_version.into()));

    let sql = format!(
        "UPDATE foreshadows SET {} WHERE id = ? AND project_id = ? AND version = ?",
        sets.join(", ")
    );
    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow_update",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT",
        },
        &requested_project_id,
        |conn| {
            let before_feed =
                load_canonical_foreshadow_snapshot_in_tx(conn, &requested_project_id, &id)?;
            let current: Option<PayoffUpdateState> = conn
                .query_row(
                    "SELECT project_id, payoff_scene_id, payoff_from_pos,
                            payoff_to_pos, version
                       FROM foreshadows WHERE id = ?1",
                    params![id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()?;
            let Some((
                project_id,
                current_scene_id,
                current_from_pos,
                current_to_pos,
                current_version,
            )) = current
            else {
                return Err(anyhow::anyhow!(
                    "FORESHADOW_VERSION_MISMATCH: row missing or expected version {base_version} is stale"
                ));
            };
            anyhow::ensure!(
                project_id == requested_project_id,
                "foreshadow update cannot cross projects"
            );
            anyhow::ensure!(
                current_version == base_version,
                "FORESHADOW_VERSION_MISMATCH: expected version {base_version}, found {current_version}"
            );

            let effective_scene_id = payoff_scene_patch.clone().unwrap_or(current_scene_id);
            let effective_from_pos = payoff_from_patch.unwrap_or(current_from_pos);
            let effective_to_pos = payoff_to_patch.unwrap_or(current_to_pos);
            validate_payoff_anchor(
                effective_scene_id.as_deref(),
                effective_from_pos,
                effective_to_pos,
            )?;
            if let Some(scene_id) = effective_scene_id.as_deref() {
                validate_payoff_scene_ownership(conn, &project_id, scene_id)?;
            }
            Database::execute_with_conn(conn, &sql, &params, "run")?;
            anyhow::ensure!(
                conn.changes() == 1,
                "FORESHADOW_VERSION_MISMATCH: expected version {base_version}"
            );
            let rows = Database::execute_with_conn(
                conn,
                "SELECT * FROM foreshadows WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?;
            record_manual_foreshadow_fields(
                conn,
                &project_id,
                &id,
                FORESHADOW_AUTHORITY_FIELDS,
                now,
            )?;
            let after = rows
                .first()
                .cloned()
                .map(Value::Object)
                .unwrap_or(Value::Null);
            let after_feed = load_canonical_foreshadow_snapshot_in_tx(conn, &project_id, &id)?;
            if writes_forward_journal {
                let before_json = before_feed.to_string();
                let after_json = after_feed.to_string();
                let result_version = after_feed
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("foreshadow update snapshot has no version"))?;
                insert_undo_journal_in_tx(
                    conn,
                    UndoJournalInsert {
                        id: undo_journal_id.as_deref().ok_or_else(|| {
                            anyhow::anyhow!("forward foreshadow update has no undo journal id")
                        })?,
                        project_id: &project_id,
                        surface: surface_for_origin(write_context.origin),
                        entity_kind: "foreshadow",
                        entity_id: &id,
                        op_kind: "update",
                        before_json: Some(&before_json),
                        after_json: Some(&after_json),
                        base_version,
                        result_version,
                        change_event_uid: Some(&write_context.event_uid),
                    },
                )?;
            }
            let transaction_id = append_foreshadow_feed_with_authority(
                conn,
                ForeshadowFeedAppend {
                    project_id: &project_id,
                    operation: "foreshadow.update",
                    entity_id: &id,
                    context: &write_context,
                    undo_journal_id: undo_journal_id.clone(),
                    events: vec![foreshadow_root_feed_event(
                        &id,
                        "metadata",
                        "update",
                        Some(&before_feed),
                        Some(&after_feed),
                        changed_paths.clone(),
                    )?],
                },
                renderer_context.as_ref(),
            )?;
            let mut response = attach_maintenance_transaction_id(after, transaction_id);
            if let (Value::Object(row), Some(undo_journal_id)) = (&mut response, undo_journal_id) {
                row.insert("undoJournalId".to_string(), Value::String(undo_journal_id));
            }
            Ok(response)
        },
    )
}

pub fn delete(db: &Database, payload: ForeshadowDeletePayload) -> anyhow::Result<Value> {
    delete_with_renderer_authority(db, payload, None)
}

pub fn delete_with_renderer_authority(
    db: &Database,
    payload: ForeshadowDeletePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        payload.base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    let write_context = resolve_write_context("foreshadow.delete", &payload.context)?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &[
                "human-direct",
                "history-replay",
                "restore-or-migration",
                "interactive-agent-command",
            ],
        )?;
        anyhow::ensure!(
            context.request_id == payload.context.request_id,
            "foreshadow delete requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == payload.context.event_uid,
            "foreshadow delete eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == payload.context.origin,
            "foreshadow delete origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == payload.context.original_transaction_id,
            "foreshadow delete originalTransactionId does not match canonical authority context"
        );
    }
    let fingerprint_payload = json!({
        "id": payload.id,
        "projectId": payload.project_id,
        "baseVersion": payload.base_version,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow_delete", &fingerprint_payload)?;
    let id = payload.id;
    let project_id = payload.project_id;
    let base_version = payload.base_version;
    let undo_id = payload
        .context
        .undo_journal_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = write_context.event_uid.clone();

    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow_delete",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_DELETE_IDEMPOTENCY_CONFLICT",
        },
        &project_id,
        |conn| {
            let before =
                crate::narrative_extraction::collect_aggregate_snapshot(conn, &project_id, &id)
                    .map_err(|error| {
                        anyhow::anyhow!(
                            "FORESHADOW_VERSION_MISMATCH: row missing or inaccessible: {error}"
                        )
                    })?;
            let current_version =
                before
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| {
                        anyhow::anyhow!("foreshadow snapshot missing version before delete")
                    })?;
            anyhow::ensure!(
            current_version == base_version,
            "FORESHADOW_VERSION_MISMATCH: expected version {base_version}, found {current_version}"
        );
            crate::narrative_extraction::ensure_foreshadow_snapshot_matches(
                conn,
                &project_id,
                &id,
                &before,
                base_version,
            )?;

            if renderer_context
                .as_ref()
                .is_some_and(|context| context.authority_route == "interactive-agent-command")
            {
                let authority_paths = FORESHADOW_AUTHORITY_FIELDS
                    .iter()
                    .map(|path| (*path).to_string())
                    .collect::<Vec<_>>();
                validate_agent_field_authority_for_entity(
                    conn,
                    &project_id,
                    "foreshadow",
                    &id,
                    &authority_paths,
                    &chrono::Utc::now().to_rfc3339(),
                )?;
            }

            let deleted = conn.execute(
                "DELETE FROM foreshadows
              WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                params![id, project_id, base_version],
            )?;
            anyhow::ensure!(
                deleted == 1,
                "FORESHADOW_VERSION_MISMATCH: expected version {base_version}"
            );

            let before_json = serde_json::to_string(&before)?;
            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &project_id,
                    surface: "manual",
                    entity_kind: "foreshadow",
                    entity_id: &id,
                    op_kind: "delete",
                    before_json: Some(&before_json),
                    after_json: None,
                    base_version: current_version,
                    result_version: current_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;
            let transaction_id = append_foreshadow_feed_with_authority(
                conn,
                ForeshadowFeedAppend {
                    project_id: &project_id,
                    operation: "foreshadow.delete",
                    entity_id: &id,
                    context: &write_context,
                    undo_journal_id: Some(undo_id.clone()),
                    events: vec![foreshadow_root_feed_event(
                        &id,
                        "catalog",
                        "delete",
                        Some(&before),
                        None,
                        vec!["/".to_string()],
                    )?],
                },
                renderer_context.as_ref(),
            )?;
            record_manual_foreshadow_fields(
                conn,
                &project_id,
                &id,
                FORESHADOW_AUTHORITY_FIELDS,
                chrono::Utc::now().timestamp_millis(),
            )?;

            Ok(serde_json::json!({
                "entityId": id,
                "projectId": project_id,
                "version": current_version,
                "changeEventUid": event_uid,
                "undoJournalId": undo_id,
                "maintenanceTransactionId": transaction_id,
            }))
        },
    )
}

/// List foreshadows and their setup rows in a single DB lock acquisition.
/// Avoids a follow-up `db_execute` IPC that can time out under lock contention.
pub fn list_with_labels(
    db: &Database,
    project_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let foreshadow_rows = db.execute(
        "SELECT * FROM foreshadows WHERE project_id = ? ORDER BY updated_at DESC",
        &[Value::String(project_id)],
        "all",
    )?;

    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();

    if foreshadows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows,
            setups: vec![],
        });
    }

    let ids: Vec<String> = foreshadows
        .iter()
        .filter_map(|v| {
            v.as_object()
                .and_then(|o| o.get("id"))
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .collect();

    let placeholders = std::iter::repeat_n("?", ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let params: Vec<Value> = ids.into_iter().map(Value::String).collect();
    let setup_rows = db.execute(
        &format!(
            "SELECT foreshadow_id, is_orphan, strength, ai_strength, ai_reasoning, scene_id \
             FROM foreshadow_setups WHERE foreshadow_id IN ({placeholders})"
        ),
        &params,
        "all",
    )?;

    let setups = setup_rows.into_iter().map(Value::Object).collect();

    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

/// Open (unresolved) foreshadows + setup label rows in one DB lock acquisition.
pub fn list_open_for_context(
    db: &Database,
    project_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let foreshadow_rows = db.execute(
        "SELECT id, title, intent, load_bearing, version, payoff_confirmed, abandoned, updated_at \
         FROM foreshadows \
         WHERE project_id = ? AND payoff_confirmed = 0 AND abandoned = 0 AND secret = 0",
        &[Value::String(project_id)],
        "all",
    )?;
    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();
    if foreshadows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows,
            setups: vec![],
        });
    }
    let ids: Vec<String> = foreshadows
        .iter()
        .filter_map(|v| {
            v.as_object()
                .and_then(|o| o.get("id"))
                .and_then(|id| id.as_str())
                .map(str::to_owned)
        })
        .collect();
    let setups = fetch_setup_label_rows(db, &ids)?;
    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

pub fn get_scene_info(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<ForeshadowSceneInfoResponse> {
    let setup_rows = db.execute(
        "SELECT DISTINCT foreshadow_id FROM foreshadow_setups WHERE scene_id = ?",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT id FROM foreshadows WHERE payoff_scene_id = ?",
        &[Value::String(scene_id)],
        "all",
    )?;
    let setup_foreshadow_ids = setup_rows
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    let payoff_foreshadow_ids = payoff_rows
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    Ok(ForeshadowSceneInfoResponse {
        setup_foreshadow_ids,
        payoff_foreshadow_ids,
    })
}

pub fn get_scene_context(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<ForeshadowSceneContextResponse> {
    let setup_rows = db.execute(
        "SELECT DISTINCT f.title AS title, f.intent AS intent \
         FROM foreshadow_setups fs \
         INNER JOIN foreshadows f ON fs.foreshadow_id = f.id \
         WHERE fs.scene_id = ? AND f.abandoned = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT f.id AS id, f.title AS title, f.intent AS intent \
         FROM foreshadows f \
         WHERE f.payoff_scene_id = ? AND f.abandoned = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_ids: Vec<String> = payoff_rows
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let setup_scene_rows = if payoff_ids.is_empty() {
        vec![]
    } else {
        let placeholders = in_placeholders(payoff_ids.len());
        let params: Vec<Value> = payoff_ids.into_iter().map(Value::String).collect();
        db.execute(
            &format!(
                "SELECT fs.foreshadow_id AS foreshadow_id, tn.title AS scene_title \
                 FROM foreshadow_setups fs \
                 INNER JOIN tree_nodes tn ON fs.scene_id = tn.id \
                 WHERE fs.foreshadow_id IN ({placeholders})"
            ),
            &params,
            "all",
        )?
        .into_iter()
        .map(Value::Object)
        .collect()
    };
    Ok(ForeshadowSceneContextResponse {
        setups: setup_rows.into_iter().map(Value::Object).collect(),
        payoffs: payoff_rows.into_iter().map(Value::Object).collect(),
        setup_scene_rows,
    })
}

pub fn list_by_codex_entry(
    db: &Database,
    codex_entry_id: String,
) -> anyhow::Result<ForeshadowListWithLabelsResponse> {
    let link_rows = db.execute(
        "SELECT foreshadow_id FROM foreshadow_codex_links WHERE codex_entry_id = ?",
        &[Value::String(codex_entry_id)],
        "all",
    )?;
    if link_rows.is_empty() {
        return Ok(ForeshadowListWithLabelsResponse {
            foreshadows: vec![],
            setups: vec![],
        });
    }
    let ids: Vec<String> = link_rows
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    let placeholders = in_placeholders(ids.len());
    let params: Vec<Value> = ids.iter().cloned().map(Value::String).collect();
    let foreshadow_rows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE id IN ({placeholders})"),
        &params,
        "all",
    )?;
    let foreshadows: Vec<Value> = foreshadow_rows.into_iter().map(Value::Object).collect();
    let setups = fetch_setup_label_rows(db, &ids)?;
    Ok(ForeshadowListWithLabelsResponse {
        foreshadows,
        setups,
    })
}

pub fn get_chapter_stats(
    db: &Database,
    chapter_id: String,
) -> anyhow::Result<ForeshadowChapterStatsBundle> {
    let scenes = db.execute(
        "SELECT id, content FROM tree_nodes WHERE parent_id = ? AND node_type = 'scene'",
        &[Value::String(chapter_id)],
        "all",
    )?;
    if scenes.is_empty() {
        return Ok(ForeshadowChapterStatsBundle {
            scenes: vec![],
            setups_on_scenes: vec![],
            payoff_foreshadows: vec![],
            related_foreshadows: vec![],
            related_setups: vec![],
        });
    }
    let scene_ids: Vec<String> = scenes
        .iter()
        .filter_map(|row| row.get("id").and_then(|v| v.as_str()).map(str::to_owned))
        .collect();
    let scene_placeholders = in_placeholders(scene_ids.len());
    let scene_params: Vec<Value> = scene_ids.iter().cloned().map(Value::String).collect();
    let setups_on_scenes = db.execute(
        &format!("SELECT * FROM foreshadow_setups WHERE scene_id IN ({scene_placeholders})"),
        &scene_params,
        "all",
    )?;
    let payoff_foreshadows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE payoff_scene_id IN ({scene_placeholders})"),
        &scene_params,
        "all",
    )?;
    let mut related_ids: Vec<String> = setups_on_scenes
        .iter()
        .filter_map(|row| {
            row.get("foreshadow_id")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        })
        .collect();
    for row in &payoff_foreshadows {
        if let Some(id) = row.get("id").and_then(|v| v.as_str()) {
            if !related_ids.iter().any(|existing| existing == id) {
                related_ids.push(id.to_string());
            }
        }
    }
    if related_ids.is_empty() {
        return Ok(ForeshadowChapterStatsBundle {
            scenes: scenes.into_iter().map(Value::Object).collect(),
            setups_on_scenes: setups_on_scenes.into_iter().map(Value::Object).collect(),
            payoff_foreshadows: payoff_foreshadows.into_iter().map(Value::Object).collect(),
            related_foreshadows: vec![],
            related_setups: vec![],
        });
    }
    let related_placeholders = in_placeholders(related_ids.len());
    let related_params: Vec<Value> = related_ids.iter().cloned().map(Value::String).collect();
    let related_foreshadows = db.execute(
        &format!("SELECT * FROM foreshadows WHERE id IN ({related_placeholders})"),
        &related_params,
        "all",
    )?;
    let related_setups = fetch_setup_label_rows(db, &related_ids)?;
    Ok(ForeshadowChapterStatsBundle {
        scenes: scenes.into_iter().map(Value::Object).collect(),
        setups_on_scenes: setups_on_scenes.into_iter().map(Value::Object).collect(),
        payoff_foreshadows: payoff_foreshadows.into_iter().map(Value::Object).collect(),
        related_foreshadows: related_foreshadows.into_iter().map(Value::Object).collect(),
        related_setups,
    })
}

pub fn get_setup(db: &Database, setup_id: String) -> anyhow::Result<Option<Value>> {
    let rows = db.execute(
        "SELECT * FROM foreshadow_setups WHERE id = ?",
        &[Value::String(setup_id)],
        "get",
    )?;
    Ok(rows.first().cloned().map(Value::Object))
}

pub fn update_setup(
    db: &Database,
    id: String,
    patch: ForeshadowSetupPatch,
) -> anyhow::Result<Value> {
    update_setup_with_operation(db, id, patch, "foreshadow.setup.update", None)
}

pub fn update_setup_with_renderer_authority(
    db: &Database,
    id: String,
    patch: ForeshadowSetupPatch,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow setup update",
        &patch.context,
        &renderer_context,
        &["human-direct", "history-replay", "restore-or-migration"],
    )?;
    update_setup_with_operation(
        db,
        id,
        patch,
        "foreshadow.setup.update",
        Some(&renderer_context),
    )
}

fn update_setup_with_operation(
    db: &Database,
    id: String,
    patch: ForeshadowSetupPatch,
    operation: &'static str,
    renderer_context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let write_context = resolve_write_context(operation, &patch.context)?;
    let requested_project_id = patch.project_id.clone();
    let base_version = patch.base_version;
    let fingerprint_payload = json!({
        "id": id,
        "projectId": requested_project_id,
        "baseVersion": base_version,
        "strength": patch.strength,
        "aiStrength": patch.ai_strength,
        "aiReasoning": patch.ai_reasoning,
        "isOrphan": patch.is_orphan,
        "lastEvaluatedAt": patch.last_evaluated_at,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint(operation, &fingerprint_payload)?;
    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: operation,
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_SETUP_UPDATE_IDEMPOTENCY_CONFLICT",
        },
        &requested_project_id,
        |conn| {
            let foreshadow_id: Option<String> = conn
                .query_row(
                    "SELECT foreshadow_id FROM foreshadow_setups WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(foreshadow_id) = foreshadow_id else {
                return Ok(Value::Null);
            };
            let before = load_foreshadow_row_in_tx(conn, &foreshadow_id)?;

            let mut sets: Vec<&str> = Vec::new();
            let mut predicates: Vec<&str> = Vec::new();
            let mut assignment_values: Vec<Value> = Vec::new();
            let mut predicate_values: Vec<Value> = Vec::new();
            let mut add_field = |column: &'static str, value: Value| {
                sets.push(match column {
                    "strength" => "strength = ?",
                    "ai_strength" => "ai_strength = ?",
                    "ai_reasoning" => "ai_reasoning = ?",
                    "is_orphan" => "is_orphan = ?",
                    "last_evaluated_at" => "last_evaluated_at = ?",
                    _ => unreachable!(),
                });
                predicates.push(match column {
                    "strength" => "strength IS NOT ?",
                    "ai_strength" => "ai_strength IS NOT ?",
                    "ai_reasoning" => "ai_reasoning IS NOT ?",
                    "is_orphan" => "is_orphan IS NOT ?",
                    "last_evaluated_at" => "last_evaluated_at IS NOT ?",
                    _ => unreachable!(),
                });
                assignment_values.push(value.clone());
                predicate_values.push(value);
            };

            if let Some(strength) = patch.strength {
                add_field(
                    "strength",
                    strength.map(Value::String).unwrap_or(Value::Null),
                );
            }
            if let Some(ai_strength) = patch.ai_strength {
                add_field(
                    "ai_strength",
                    ai_strength.map(Value::String).unwrap_or(Value::Null),
                );
            }
            if let Some(ai_reasoning) = patch.ai_reasoning {
                add_field(
                    "ai_reasoning",
                    ai_reasoning.map(Value::String).unwrap_or(Value::Null),
                );
            }
            if let Some(is_orphan) = patch.is_orphan {
                add_field("is_orphan", Value::Bool(is_orphan));
            }
            if let Some(last_evaluated_at) = patch.last_evaluated_at {
                add_field(
                    "last_evaluated_at",
                    last_evaluated_at
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null),
                );
            }

            let changed = if sets.is_empty() {
                false
            } else {
                sets.push("updated_at = ?");
                assignment_values.push(Value::Number(now.into()));
                assignment_values.push(Value::String(id.clone()));
                assignment_values.extend(predicate_values);
                let sql = format!(
                    "UPDATE foreshadow_setups SET {} WHERE id = ? AND ({})",
                    sets.join(", "),
                    predicates.join(" OR ")
                );
                Database::execute_with_conn(conn, &sql, &assignment_values, "run")?;
                conn.changes() == 1
            };
            let project_id: String = conn.query_row(
                "SELECT project_id FROM foreshadows WHERE id = ?1",
                params![foreshadow_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                project_id == requested_project_id,
                "foreshadow setup update cannot cross projects"
            );
            let result = finish_foreshadow_child_write(
                conn,
                &foreshadow_id,
                changed,
                Some(base_version),
                now,
            )?;
            record_manual_foreshadow_fields(conn, &project_id, &foreshadow_id, &["/setups"], now)?;
            if changed {
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id: &project_id,
                        operation,
                        entity_id: &foreshadow_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: vec![foreshadow_root_feed_event(
                            &foreshadow_id,
                            "association",
                            "update",
                            Some(&before),
                            Some(&result),
                            vec![format!("/setups/{}", json_pointer_segment(&id))],
                        )?],
                    },
                    renderer_context,
                )?;
                return Ok(attach_maintenance_transaction_id(result, transaction_id));
            }
            Ok(result)
        },
    )
}

pub fn get(db: &Database, id: String) -> anyhow::Result<Value> {
    let foreshadow_rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id.clone())],
        "get",
    )?;
    let setup_rows = db.execute(
        "SELECT * FROM foreshadow_setups WHERE foreshadow_id = ? ORDER BY created_at ASC",
        &[Value::String(id)],
        "all",
    )?;
    let mut detail = serde_json::Map::new();
    detail.insert(
        "foreshadow".to_string(),
        foreshadow_rows
            .first()
            .cloned()
            .map(Value::Object)
            .unwrap_or(Value::Null),
    );
    detail.insert(
        "setups".to_string(),
        Value::Array(setup_rows.into_iter().map(Value::Object).collect()),
    );
    Ok(Value::Object(detail))
}

pub fn link_codex(db: &Database, payload: ForeshadowCodexLinkPayload) -> anyhow::Result<Value> {
    link_codex_with_context(db, payload, None)
}

pub fn link_codex_with_renderer_authority(
    db: &Database,
    payload: ForeshadowCodexLinkPayload,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow Codex link create",
        &payload.context,
        &renderer_context,
        &["human-direct"],
    )?;
    link_codex_with_context(db, payload, Some(renderer_context))
}

fn link_codex_with_context(
    db: &Database,
    payload: ForeshadowCodexLinkPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let write_context = resolve_write_context("foreshadow.codex-link.create", &payload.context)?;
    let fingerprint_payload = json!({
        "foreshadowId": payload.foreshadow_id,
        "codexId": payload.codex_id,
        "projectId": payload.project_id,
        "baseVersion": payload.base_version,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow.codex-link.create", &fingerprint_payload)?;
    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow.codex-link.create",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_CODEX_LINK_CREATE_IDEMPOTENCY_CONFLICT",
        },
        &payload.project_id,
        |conn| {
            let projects: Option<(String, String)> = conn
                .query_row(
                    "SELECT f.project_id, ce.project_id
                   FROM foreshadows f
                   JOIN codex_entries ce ON ce.id = ?2
                  WHERE f.id = ?1",
                    params![payload.foreshadow_id, payload.codex_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if !matches!(projects, Some((ref left, ref right)) if left == right) {
                anyhow::bail!("foreshadow Codex link must stay within one project");
            }
            let project_id = projects
                .as_ref()
                .map(|(project_id, _)| project_id.clone())
                .ok_or_else(|| anyhow::anyhow!("foreshadow Codex link project is missing"))?;
            anyhow::ensure!(
                project_id == payload.project_id,
                "foreshadow Codex link cannot cross projects"
            );
            let before = load_foreshadow_row_in_tx(conn, &payload.foreshadow_id)?;
            let changed = conn.execute(
                "INSERT OR IGNORE INTO foreshadow_codex_links
                (foreshadow_id, codex_entry_id) VALUES (?1, ?2)",
                params![payload.foreshadow_id, payload.codex_id],
            )? == 1;
            let result = finish_foreshadow_child_write(
                conn,
                &payload.foreshadow_id,
                changed,
                Some(payload.base_version),
                now,
            )?;
            record_manual_foreshadow_fields(
                conn,
                &project_id,
                &payload.foreshadow_id,
                &["/codexEntryIds"],
                now,
            )?;
            if changed {
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id: &project_id,
                        operation: "foreshadow.codex-link.create",
                        entity_id: &payload.foreshadow_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: vec![foreshadow_root_feed_event(
                            &payload.foreshadow_id,
                            "association",
                            "update",
                            Some(&before),
                            Some(&result),
                            vec![format!(
                                "/codexLinks/{}",
                                json_pointer_segment(&payload.codex_id)
                            )],
                        )?],
                    },
                    renderer_context.as_ref(),
                )?;
                return Ok(attach_maintenance_transaction_id(result, transaction_id));
            }
            Ok(result)
        },
    )
}

pub fn unlink_codex(db: &Database, payload: ForeshadowCodexLinkPayload) -> anyhow::Result<Value> {
    unlink_codex_with_context(db, payload, None)
}

pub fn unlink_codex_with_renderer_authority(
    db: &Database,
    payload: ForeshadowCodexLinkPayload,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow Codex link delete",
        &payload.context,
        &renderer_context,
        &["human-direct"],
    )?;
    unlink_codex_with_context(db, payload, Some(renderer_context))
}

fn unlink_codex_with_context(
    db: &Database,
    payload: ForeshadowCodexLinkPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    // The IPC contract carries globally unique entity ids but no project id.
    // Scope deletion to the exact composite association; intentionally do not
    // require same-project ownership here so legacy invalid links remain
    // removable after `link_codex` starts rejecting their creation.
    let now = chrono::Utc::now().timestamp_millis();
    let write_context = resolve_write_context("foreshadow.codex-link.delete", &payload.context)?;
    let fingerprint_payload = json!({
        "foreshadowId": payload.foreshadow_id,
        "codexId": payload.codex_id,
        "projectId": payload.project_id,
        "baseVersion": payload.base_version,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow.codex-link.delete", &fingerprint_payload)?;
    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow.codex-link.delete",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_CODEX_LINK_DELETE_IDEMPOTENCY_CONFLICT",
        },
        &payload.project_id,
        |conn| {
            let project_id: String = conn.query_row(
                "SELECT project_id FROM foreshadows WHERE id = ?1",
                params![payload.foreshadow_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                project_id == payload.project_id,
                "foreshadow Codex unlink cannot cross projects"
            );
            let before = load_foreshadow_row_in_tx(conn, &payload.foreshadow_id)?;
            let changed = conn.execute(
                "DELETE FROM foreshadow_codex_links
              WHERE foreshadow_id = ?1 AND codex_entry_id = ?2",
                params![payload.foreshadow_id, payload.codex_id],
            )? == 1;
            let result = finish_foreshadow_child_write(
                conn,
                &payload.foreshadow_id,
                changed,
                Some(payload.base_version),
                now,
            )?;
            record_manual_foreshadow_fields(
                conn,
                &project_id,
                &payload.foreshadow_id,
                &["/codexEntryIds"],
                now,
            )?;
            if changed {
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id: &project_id,
                        operation: "foreshadow.codex-link.delete",
                        entity_id: &payload.foreshadow_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: vec![foreshadow_root_feed_event(
                            &payload.foreshadow_id,
                            "association",
                            "update",
                            Some(&before),
                            Some(&result),
                            vec![format!(
                                "/codexLinks/{}",
                                json_pointer_segment(&payload.codex_id)
                            )],
                        )?],
                    },
                    renderer_context.as_ref(),
                )?;
                return Ok(attach_maintenance_transaction_id(result, transaction_id));
            }
            Ok(result)
        },
    )
}

/// Legacy Tauri v1 compatibility route. The current Electron renderer does
/// not expose this standalone mutation; canonical Codex writers perform the
/// same invalidation inside their own transaction.
pub fn mark_linked_codex_dirty(
    db: &Database,
    project_id: String,
    codex_entry_id: String,
) -> anyhow::Result<Vec<Value>> {
    let now = chrono::Utc::now().timestamp_millis();
    with_immediate_transaction(db, |conn| {
        Database::execute_with_conn(
            conn,
            "UPDATE foreshadows
            SET codex_link_dirty_at = ?, version = version + 1, updated_at = ?
          WHERE project_id = ?
            AND id IN (
                SELECT foreshadow_id
                  FROM foreshadow_codex_links
                 WHERE codex_entry_id = ?
            )",
            &[
                Value::Number(now.into()),
                Value::Number(now.into()),
                Value::String(project_id.clone()),
                Value::String(codex_entry_id.clone()),
            ],
            "run",
        )?;
        let rows = Database::execute_with_conn(
            conn,
            "SELECT f.*
               FROM foreshadows f
               JOIN foreshadow_codex_links link ON link.foreshadow_id = f.id
              WHERE f.project_id = ? AND link.codex_entry_id = ?
              ORDER BY f.id",
            &[Value::String(project_id), Value::String(codex_entry_id)],
            "all",
        )?;
        Ok(rows.into_iter().map(Value::Object).collect())
    })
}

pub fn list_linked_codex(db: &Database, foreshadow_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT ce.* FROM codex_entries ce \
         JOIN foreshadow_codex_links fcl ON ce.id = fcl.codex_entry_id \
         WHERE fcl.foreshadow_id = ? \
         ORDER BY ce.name ASC",
        &[Value::String(foreshadow_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

pub fn set_setup_strength(
    db: &Database,
    payload: ForeshadowSetupStrengthPayload,
) -> anyhow::Result<Value> {
    set_setup_strength_with_context(db, payload, None)
}

pub fn set_setup_strength_with_renderer_authority(
    db: &Database,
    payload: ForeshadowSetupStrengthPayload,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow setup strength",
        &payload.context,
        &renderer_context,
        &["human-direct"],
    )?;
    set_setup_strength_with_context(db, payload, Some(renderer_context))
}

fn set_setup_strength_with_context(
    db: &Database,
    payload: ForeshadowSetupStrengthPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    update_setup_with_operation(
        db,
        payload.setup_id,
        ForeshadowSetupPatch {
            context: payload.context,
            project_id: payload.project_id,
            base_version: payload.base_version,
            strength: Some(payload.strength),
            ai_strength: None,
            ai_reasoning: None,
            is_orphan: None,
            last_evaluated_at: None,
        },
        "foreshadow.setup.strength",
        renderer_context.as_ref(),
    )
}

pub fn setup_create_ai(db: &Database, input: SetupCreateAiInput) -> anyhow::Result<Value> {
    setup_create_ai_with_context(db, input, None)
}

pub fn setup_create_ai_with_renderer_authority(
    db: &Database,
    input: SetupCreateAiInput,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow setup create",
        &input.context,
        &renderer_context,
        &["human-direct", "interactive-agent-command"],
    )?;
    setup_create_ai_with_context(db, input, Some(renderer_context))
}

fn setup_create_ai_with_context(
    db: &Database,
    input: SetupCreateAiInput,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let write_context = resolve_write_context("foreshadow.setup.create", &input.context)?;
    let fingerprint_payload = json!({
        "id": input.id,
        "projectId": input.project_id,
        "foreshadowId": input.foreshadow_id,
        "baseVersion": input.base_version,
        "sceneId": input.scene_id,
        "fromPos": input.from_pos,
        "toPos": input.to_pos,
        "kind": input.kind,
        "strength": input.strength,
        "aiStrength": input.ai_strength,
        "attribution": input.attribution,
        "aiRationale": input.ai_rationale,
        "aiReasoning": input.ai_reasoning,
        "lastEvaluatedAt": input.last_evaluated_at,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow.setup.create", &fingerprint_payload)?;
    run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow.setup.create",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_SETUP_CREATE_IDEMPOTENCY_CONFLICT",
        },
        &input.project_id,
        |conn| {
            let before = load_foreshadow_row_in_tx(conn, &input.foreshadow_id)?;
            anyhow::ensure!(
                before.get("project_id").and_then(Value::as_str) == Some(input.project_id.as_str()),
                "foreshadow setup create cannot cross projects"
            );
            let existing: Option<(String, String, String, i64, i64, i64)> = conn
                .query_row(
                    "SELECT foreshadow_id, scene_id, semantic_key, from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = ?1",
                    params![input.id],
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
                )
                .optional()?;
            if let Some((existing_foreshadow_id, existing_scene_id, ..)) = existing.as_ref() {
                if existing_foreshadow_id != &input.foreshadow_id
                    || existing_scene_id != &input.scene_id
                {
                    anyhow::bail!(
                        "foreshadow setup '{}' belongs to a different anchor",
                        input.id
                    );
                }
            }
            validate_setup_anchor_ownership(conn, &input.foreshadow_id, &input.scene_id)?;
            let semantic_key = setup_semantic_key_for_upsert(
                &input.id,
                &input.foreshadow_id,
                &input.scene_id,
                input.from_pos,
                input.to_pos,
                existing.as_ref().map(|(_, _, key, ..)| key.as_str()),
            );
            let changed = existing.as_ref().is_none_or(
                |(_, _, existing_key, existing_from, existing_to, existing_orphan)| {
                    *existing_from != input.from_pos
                        || *existing_to != input.to_pos
                        || existing_key != &semantic_key
                        || *existing_orphan != 0
                },
            );
            if changed {
                let affected = conn.execute(
                    "INSERT INTO foreshadow_setups
             (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength,
              attribution, ai_rationale, ai_reasoning, last_evaluated_at, is_orphan,
              semantic_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?14, ?14)
             ON CONFLICT(id) DO UPDATE SET
               from_pos = excluded.from_pos,
               to_pos = excluded.to_pos,
               semantic_key = excluded.semantic_key,
               is_orphan = 0,
               updated_at = excluded.updated_at",
                    params![
                        input.id,
                        input.foreshadow_id,
                        input.scene_id,
                        input.from_pos,
                        input.to_pos,
                        input.kind,
                        input.strength,
                        input.ai_strength,
                        input.attribution,
                        input.ai_rationale,
                        input.ai_reasoning,
                        input.last_evaluated_at,
                        semantic_key,
                        now,
                    ],
                )?;
                anyhow::ensure!(
                    affected == 1,
                    "foreshadow setup write affected {affected} rows"
                );
            }
            let result = finish_foreshadow_child_write(
                conn,
                &input.foreshadow_id,
                changed,
                Some(input.base_version),
                now,
            )?;
            if changed {
                let project_id: String = conn.query_row(
                    "SELECT project_id FROM foreshadows WHERE id = ?1",
                    params![input.foreshadow_id],
                    |row| row.get(0),
                )?;
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id: &project_id,
                        operation: "foreshadow.setup.create",
                        entity_id: &input.foreshadow_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: vec![foreshadow_root_feed_event(
                            &input.foreshadow_id,
                            "association",
                            "update",
                            Some(&before),
                            Some(&result),
                            vec![format!("/setups/{}", json_pointer_segment(&input.id))],
                        )?],
                    },
                    renderer_context.as_ref(),
                )?;
                return Ok(attach_maintenance_transaction_id(result, transaction_id));
            }
            Ok(result)
        },
    )
}

pub fn resolve_orphan(db: &Database, payload: OrphanResolvePayload) -> anyhow::Result<Value> {
    resolve_orphan_with_context(db, payload, None)
}

pub fn resolve_orphan_with_renderer_authority(
    db: &Database,
    payload: OrphanResolvePayload,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_foreshadow_renderer_context(
        "foreshadow orphan resolve",
        &payload.context,
        &renderer_context,
        &["human-direct"],
    )?;
    resolve_orphan_with_context(db, payload, Some(renderer_context))
}

fn resolve_orphan_with_context(
    db: &Database,
    payload: OrphanResolvePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    let write_context = resolve_write_context("foreshadow.orphan.resolve", &payload.context)?;
    let payload_hash = payload_fingerprint(
        "foreshadow.orphan.resolve",
        &json!({
            "projectId": payload.project_id,
            "setupId": payload.setup_id,
            "baseVersion": payload.base_version,
            "action": payload.action,
            "sceneId": payload.scene_id,
            "fromPos": payload.from_pos,
            "toPos": payload.to_pos,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
        }),
    )?;
    match payload.action.as_str() {
        "reanchor" => {
            let scene_id = payload
                .scene_id
                .ok_or_else(|| anyhow::anyhow!("reanchor requires scene_id"))?;
            let from_pos = payload
                .from_pos
                .ok_or_else(|| anyhow::anyhow!("reanchor requires from_pos"))?;
            let to_pos = payload
                .to_pos
                .ok_or_else(|| anyhow::anyhow!("reanchor requires to_pos"))?;
            run_atomic_foreshadow_mutation(
                db,
                IdempotencyRequest {
                    domain: "foreshadow.orphan.resolve",
                    request_id: Some(&write_context.request_id),
                    payload_hash: &payload_hash,
                    conflict_marker: "FORESHADOW_ORPHAN_RESOLVE_IDEMPOTENCY_CONFLICT",
                },
                &payload.project_id,
                |conn| {
                    let existing: Option<(String, String, String, i64, i64, i64)> = conn
                    .query_row(
                        "SELECT foreshadow_id, semantic_key, scene_id, from_pos, to_pos, is_orphan
                           FROM foreshadow_setups WHERE id = ?1",
                        params![payload.setup_id],
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
                    )
                    .optional()?;
                    let Some((
                        foreshadow_id,
                        existing_semantic_key,
                        current_scene_id,
                        current_from_pos,
                        current_to_pos,
                        current_is_orphan,
                    )) = existing
                    else {
                        return Ok(serde_json::json!({ "setupId": null, "foreshadow": null }));
                    };
                    let before = load_foreshadow_row_in_tx(conn, &foreshadow_id)?;
                    anyhow::ensure!(
                        before.get("project_id").and_then(Value::as_str)
                            == Some(payload.project_id.as_str()),
                        "foreshadow orphan reanchor cannot cross projects"
                    );
                    validate_setup_anchor_ownership(conn, &foreshadow_id, &scene_id)?;
                    let semantic_key = setup_semantic_key_for_upsert(
                        &payload.setup_id,
                        &foreshadow_id,
                        &scene_id,
                        from_pos,
                        to_pos,
                        Some(&existing_semantic_key),
                    );
                    let changed = current_scene_id != scene_id
                        || current_from_pos != from_pos
                        || current_to_pos != to_pos
                        || existing_semantic_key != semantic_key
                        || current_is_orphan != 0;
                    if changed {
                        let affected = conn.execute(
                            "UPDATE foreshadow_setups
                        SET scene_id = ?1, from_pos = ?2, to_pos = ?3,
                            semantic_key = ?4, is_orphan = 0, updated_at = ?5
                      WHERE id = ?6",
                            params![
                                scene_id,
                                from_pos,
                                to_pos,
                                semantic_key,
                                now,
                                payload.setup_id
                            ],
                        )?;
                        anyhow::ensure!(
                            affected == 1,
                            "foreshadow setup reanchor affected {affected} rows"
                        );
                    }
                    let mut foreshadow = finish_foreshadow_child_write(
                        conn,
                        &foreshadow_id,
                        changed,
                        Some(payload.base_version),
                        now,
                    )?;
                    if changed {
                        let project_id: String = conn.query_row(
                            "SELECT project_id FROM foreshadows WHERE id = ?1",
                            params![foreshadow_id],
                            |row| row.get(0),
                        )?;
                        record_manual_foreshadow_fields(
                            conn,
                            &project_id,
                            &foreshadow_id,
                            &["/setups"],
                            now,
                        )?;
                        let transaction_id = append_foreshadow_feed_with_authority(
                            conn,
                            ForeshadowFeedAppend {
                                project_id: &project_id,
                                operation: "foreshadow.orphan.resolve",
                                entity_id: &foreshadow_id,
                                context: &write_context,
                                undo_journal_id: None,
                                events: vec![foreshadow_root_feed_event(
                                    &foreshadow_id,
                                    "association",
                                    "update",
                                    Some(&before),
                                    Some(&foreshadow),
                                    vec![format!(
                                        "/setups/{}",
                                        json_pointer_segment(&payload.setup_id)
                                    )],
                                )?],
                            },
                            renderer_context.as_ref(),
                        )?;
                        foreshadow = attach_maintenance_transaction_id(foreshadow, transaction_id);
                    }
                    Ok(serde_json::json!({ "setupId": null, "foreshadow": foreshadow }))
                },
            )
        }
        "delete" => run_atomic_foreshadow_mutation(
            db,
            IdempotencyRequest {
                domain: "foreshadow.orphan.resolve",
                request_id: Some(&write_context.request_id),
                payload_hash: &payload_hash,
                conflict_marker: "FORESHADOW_ORPHAN_RESOLVE_IDEMPOTENCY_CONFLICT",
            },
            &payload.project_id,
            |conn| {
                let foreshadow_id: Option<String> = conn
                    .query_row(
                        "SELECT foreshadow_id FROM foreshadow_setups WHERE id = ?1",
                        params![payload.setup_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(foreshadow_id) = foreshadow_id else {
                    return Ok(serde_json::json!({ "setupId": null, "foreshadow": null }));
                };
                let before = load_foreshadow_row_in_tx(conn, &foreshadow_id)?;
                anyhow::ensure!(
                    before.get("project_id").and_then(Value::as_str)
                        == Some(payload.project_id.as_str()),
                    "foreshadow orphan delete cannot cross projects"
                );
                let changed = conn.execute(
                    "DELETE FROM foreshadow_setups WHERE id = ?1",
                    params![payload.setup_id],
                )? == 1;
                let mut foreshadow = finish_foreshadow_child_write(
                    conn,
                    &foreshadow_id,
                    changed,
                    Some(payload.base_version),
                    now,
                )?;
                if changed {
                    let project_id: String = conn.query_row(
                        "SELECT project_id FROM foreshadows WHERE id = ?1",
                        params![foreshadow_id],
                        |row| row.get(0),
                    )?;
                    record_manual_foreshadow_fields(
                        conn,
                        &project_id,
                        &foreshadow_id,
                        &["/setups"],
                        now,
                    )?;
                    let transaction_id = append_foreshadow_feed_with_authority(
                        conn,
                        ForeshadowFeedAppend {
                            project_id: &project_id,
                            operation: "foreshadow.orphan.resolve",
                            entity_id: &foreshadow_id,
                            context: &write_context,
                            undo_journal_id: None,
                            events: vec![foreshadow_root_feed_event(
                                &foreshadow_id,
                                "association",
                                "update",
                                Some(&before),
                                Some(&foreshadow),
                                vec![format!(
                                    "/setups/{}",
                                    json_pointer_segment(&payload.setup_id)
                                )],
                            )?],
                        },
                        renderer_context.as_ref(),
                    )?;
                    foreshadow = attach_maintenance_transaction_id(foreshadow, transaction_id);
                }
                Ok(serde_json::json!({ "setupId": null, "foreshadow": foreshadow }))
            },
        ),
        "reinsert" => run_atomic_foreshadow_mutation(
            db,
            IdempotencyRequest {
                domain: "foreshadow.orphan.resolve",
                request_id: Some(&write_context.request_id),
                payload_hash: &payload_hash,
                conflict_marker: "FORESHADOW_ORPHAN_RESOLVE_IDEMPOTENCY_CONFLICT",
            },
            &payload.project_id,
            |conn| {
                #[allow(clippy::type_complexity)]
                let existing: Option<(
                    String,
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    String,
                    Option<String>,
                    Option<i64>,
                    String,
                    Option<String>,
                )> = conn
                    .query_row(
                        "SELECT foreshadow_id, strength, ai_strength, ai_reasoning,
                                attribution, ai_rationale, last_evaluated_at, role,
                                evidence_anchor_id
                           FROM foreshadow_setups WHERE id = ?1",
                        params![payload.setup_id],
                        |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                                row.get(5)?,
                                row.get(6)?,
                                row.get(7)?,
                                row.get(8)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((
                    foreshadow_id,
                    strength,
                    ai_strength,
                    ai_reasoning,
                    attribution,
                    ai_rationale,
                    last_evaluated_at,
                    role,
                    evidence_anchor_id,
                )) = existing
                else {
                    return Ok(serde_json::json!({ "setupId": null, "foreshadow": null }));
                };
                let before = load_foreshadow_row_in_tx(conn, &foreshadow_id)?;
                anyhow::ensure!(
                    before.get("project_id").and_then(Value::as_str)
                        == Some(payload.project_id.as_str()),
                    "foreshadow orphan reinsert cannot cross projects"
                );
                let scene_id = payload
                    .scene_id
                    .ok_or_else(|| anyhow::anyhow!("reinsert requires scene_id"))?;
                let from_pos = payload
                    .from_pos
                    .ok_or_else(|| anyhow::anyhow!("reinsert requires from_pos"))?;
                let to_pos = payload
                    .to_pos
                    .ok_or_else(|| anyhow::anyhow!("reinsert requires to_pos"))?;
                validate_setup_anchor_ownership(conn, &foreshadow_id, &scene_id)?;
                let semantic_key = setup_semantic_key(&foreshadow_id, &scene_id, from_pos, to_pos);
                let new_id = uuid::Uuid::new_v4().to_string();
                let deleted = conn.execute(
                    "DELETE FROM foreshadow_setups WHERE id = ?1",
                    params![payload.setup_id],
                )?;
                anyhow::ensure!(
                    deleted == 1,
                    "foreshadow setup reinsert delete affected {deleted} rows"
                );
                let inserted = conn.execute(
                    "INSERT INTO foreshadow_setups
                        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role,
                         strength, ai_strength, ai_reasoning, attribution, ai_rationale,
                         last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key,
                         created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'inserted_new', ?6, ?7, ?8, ?9,
                             ?10, ?11, ?12, 0, ?13, ?14, ?15, ?15)",
                    params![
                        new_id,
                        foreshadow_id,
                        scene_id,
                        from_pos,
                        to_pos,
                        role,
                        strength,
                        ai_strength,
                        ai_reasoning,
                        attribution,
                        ai_rationale,
                        last_evaluated_at,
                        evidence_anchor_id,
                        semantic_key,
                        now,
                    ],
                )?;
                anyhow::ensure!(
                    inserted == 1,
                    "foreshadow setup reinsert insert affected {inserted} rows"
                );
                let mut foreshadow = finish_foreshadow_child_write(
                    conn,
                    &foreshadow_id,
                    true,
                    Some(payload.base_version),
                    now,
                )?;
                let project_id: String = conn.query_row(
                    "SELECT project_id FROM foreshadows WHERE id = ?1",
                    params![foreshadow_id],
                    |row| row.get(0),
                )?;
                record_manual_foreshadow_fields(
                    conn,
                    &project_id,
                    &foreshadow_id,
                    &["/setups"],
                    now,
                )?;
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id: &project_id,
                        operation: "foreshadow.orphan.resolve",
                        entity_id: &foreshadow_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: vec![foreshadow_root_feed_event(
                            &foreshadow_id,
                            "association",
                            "update",
                            Some(&before),
                            Some(&foreshadow),
                            vec![
                                format!("/setups/{}", json_pointer_segment(&payload.setup_id)),
                                format!("/setups/{}", json_pointer_segment(&new_id)),
                            ],
                        )?],
                    },
                    renderer_context.as_ref(),
                )?;
                foreshadow = attach_maintenance_transaction_id(foreshadow, transaction_id);
                Ok(serde_json::json!({ "setupId": new_id, "foreshadow": foreshadow }))
            },
        ),
        _ => Ok(serde_json::json!({ "setupId": null, "foreshadow": null })),
    }
}

pub fn save_anchors_for_scene(
    db: &Database,
    payload: ForeshadowAnchorSavePayload,
) -> anyhow::Result<Vec<Value>> {
    save_anchors_for_scene_with_context(db, payload, None)
}

pub fn save_anchors_for_scene_with_renderer_authority(
    db: &Database,
    payload: ForeshadowAnchorSavePayload,
    renderer_context: RendererCanonicalWriteContext,
) -> anyhow::Result<Vec<Value>> {
    validate_foreshadow_renderer_context(
        "foreshadow anchor save",
        &payload.context,
        &renderer_context,
        &["human-direct"],
    )?;
    save_anchors_for_scene_with_context(db, payload, Some(renderer_context))
}

fn save_anchors_for_scene_with_context(
    db: &Database,
    payload: ForeshadowAnchorSavePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Vec<Value>> {
    let write_context = resolve_write_context("foreshadow.anchors.save", &payload.context)?;
    let scene_id = payload.scene_id;
    let project_id = payload.project_id;
    let setups = payload.setups;
    let payoffs = payload.payoffs;
    let base_versions = payload.base_versions;
    let doc_content_size = payload.doc_content_size;
    let fingerprint_payload = json!({
        "sceneId": scene_id,
        "projectId": project_id,
        "setups": setups,
        "payoffs": payoffs,
        "baseVersions": base_versions,
        "docContentSize": doc_content_size,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
    });
    let payload_hash = payload_fingerprint("foreshadow.anchors.save", &fingerprint_payload)?;
    anyhow::ensure!(doc_content_size >= 0, "docContentSize must be non-negative");
    for setup in &setups {
        anyhow::ensure!(
            setup.base_version >= 0,
            "foreshadow setup baseVersion must be non-negative"
        );
        anyhow::ensure!(
            base_versions.get(&setup.foreshadow_id) == Some(&setup.base_version),
            "foreshadow setup '{}' baseVersion disagrees with the scene snapshot",
            setup.id
        );
        anyhow::ensure!(
            setup.scene_id == scene_id,
            "foreshadow setup scene must match the saved scene"
        );
        anyhow::ensure!(
            setup.from_pos >= 0
                && setup.to_pos >= setup.from_pos
                && setup.to_pos <= doc_content_size,
            "foreshadow setup range must satisfy 0 <= from <= to <= docContentSize"
        );
    }
    let mut payoff_ids = HashSet::new();
    for payoff in &payoffs {
        anyhow::ensure!(
            payoff_ids.insert(payoff.foreshadow_id.as_str()),
            "duplicate foreshadow payoff '{}' in one scene save",
            payoff.foreshadow_id
        );
        anyhow::ensure!(
            payoff.base_version >= 0,
            "foreshadow payoff baseVersion must be non-negative"
        );
        anyhow::ensure!(
            base_versions.get(&payoff.foreshadow_id) == Some(&payoff.base_version),
            "foreshadow payoff '{}' baseVersion disagrees with the scene snapshot",
            payoff.foreshadow_id
        );
        anyhow::ensure!(
            payoff.scene_id == scene_id,
            "foreshadow payoff scene must match the saved scene"
        );
        anyhow::ensure!(
            payoff.from_pos >= 0
                && payoff.to_pos >= payoff.from_pos
                && payoff.to_pos <= doc_content_size,
            "foreshadow payoff range must satisfy 0 <= from <= to <= docContentSize"
        );
    }

    let now = chrono::Utc::now().timestamp_millis();
    let value = run_atomic_foreshadow_mutation(
        db,
        IdempotencyRequest {
            domain: "foreshadow.anchors.save",
            request_id: Some(&write_context.request_id),
            payload_hash: &payload_hash,
            conflict_marker: "FORESHADOW_ANCHOR_SAVE_IDEMPOTENCY_CONFLICT",
        },
        &project_id,
        |conn| {
            let scene_project_id: Option<String> = conn
                .query_row(
                    "SELECT project_id FROM tree_nodes WHERE id = ?1 AND node_type = 'scene'",
                    params![scene_id],
                    |row| row.get(0),
                )
                .optional()?;
            anyhow::ensure!(
                scene_project_id.as_deref() == Some(project_id.as_str()),
                "foreshadow anchor save scene cannot cross projects"
            );
            let mut touched_roots = BTreeSet::new();
            let mut changed_roots = BTreeSet::new();
            let mut before_roots = HashMap::<String, Value>::new();
            let mut changed_paths = HashMap::<String, BTreeSet<String>>::new();

            // Validate every payoff token against the pre-write aggregate state.
            // Root versions are advanced only after all setup/payoff changes have
            // been applied, so one root can safely carry both kinds in one save.
            for payoff in &payoffs {
                validate_setup_anchor_ownership(conn, &payoff.foreshadow_id, &payoff.scene_id)?;
                if !before_roots.contains_key(&payoff.foreshadow_id) {
                    before_roots.insert(
                        payoff.foreshadow_id.clone(),
                        load_foreshadow_row_in_tx(conn, &payoff.foreshadow_id)?,
                    );
                }
                let current: Option<PayoffRootState> = conn
                    .query_row(
                        "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                       FROM foreshadows WHERE id = ?1",
                        params![payoff.foreshadow_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let Some((current_scene_id, current_from, current_to, current_version)) = current
                else {
                    anyhow::bail!(
                        "foreshadow payoff '{}' does not exist",
                        payoff.foreshadow_id
                    );
                };
                let changed = current_scene_id.as_deref() != Some(payoff.scene_id.as_str())
                    || current_from != Some(payoff.from_pos)
                    || current_to != Some(payoff.to_pos);
                if changed {
                    anyhow::ensure!(
                        current_version == payoff.base_version,
                        "FORESHADOW_VERSION_MISMATCH: payoff '{}' expected version {}, found {}",
                        payoff.foreshadow_id,
                        payoff.base_version,
                        current_version
                    );
                }
                touched_roots.insert(payoff.foreshadow_id.clone());
            }

            for setup in &setups {
                if !before_roots.contains_key(&setup.foreshadow_id) {
                    before_roots.insert(
                        setup.foreshadow_id.clone(),
                        load_foreshadow_row_in_tx(conn, &setup.foreshadow_id)?,
                    );
                }
                let existing: Option<(String, String, String, i64, i64, i64)> = conn
                    .query_row(
                        "SELECT foreshadow_id, semantic_key, scene_id, from_pos, to_pos, is_orphan
                       FROM foreshadow_setups WHERE id = ?1",
                        params![setup.id],
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
                    )
                    .optional()?;
                if let Some((existing_foreshadow_id, ..)) = existing.as_ref() {
                    anyhow::ensure!(
                        existing_foreshadow_id == &setup.foreshadow_id,
                        "foreshadow setup '{}' belongs to a different foreshadow",
                        setup.id
                    );
                }
                validate_setup_anchor_ownership(conn, &setup.foreshadow_id, &setup.scene_id)?;
                let semantic_key = setup_semantic_key_for_upsert(
                    &setup.id,
                    &setup.foreshadow_id,
                    &setup.scene_id,
                    setup.from_pos,
                    setup.to_pos,
                    existing.as_ref().map(|(_, key, ..)| key.as_str()),
                );
                let changed = existing.as_ref().is_none_or(
                    |(_, current_key, current_scene, current_from, current_to, current_orphan)| {
                        current_key != &semantic_key
                            || current_scene != &setup.scene_id
                            || *current_from != setup.from_pos
                            || *current_to != setup.to_pos
                            || *current_orphan != 0
                    },
                );
                if changed {
                    let affected = conn.execute(
                        "INSERT INTO foreshadow_setups
                        (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
                         attribution, is_orphan, semantic_key, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'designated_existing', 'human', 0, ?6, ?7, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                        scene_id = excluded.scene_id,
                        from_pos = excluded.from_pos,
                        to_pos = excluded.to_pos,
                        semantic_key = excluded.semantic_key,
                        is_orphan = 0,
                        updated_at = excluded.updated_at",
                        params![
                            setup.id,
                            setup.foreshadow_id,
                            setup.scene_id,
                            setup.from_pos,
                            setup.to_pos,
                            semantic_key,
                            now,
                        ],
                    )?;
                    anyhow::ensure!(
                        affected == 1,
                        "foreshadow setup write affected {affected} rows"
                    );
                    changed_roots.insert(setup.foreshadow_id.clone());
                    changed_paths
                        .entry(setup.foreshadow_id.clone())
                        .or_default()
                        .insert(format!(
                            "/setups/{}/anchor",
                            json_pointer_segment(&setup.id)
                        ));
                }
                touched_roots.insert(setup.foreshadow_id.clone());
            }

            for payoff in &payoffs {
                let changed = conn.execute(
                "UPDATE foreshadows
                    SET payoff_scene_id = ?1, payoff_from_pos = ?2,
                        payoff_to_pos = ?3
                  WHERE id = ?4
                    AND (payoff_scene_id IS NOT ?1 OR payoff_from_pos IS NOT ?2 OR payoff_to_pos IS NOT ?3)",
                params![
                    payoff.scene_id,
                    payoff.from_pos,
                    payoff.to_pos,
                    payoff.foreshadow_id,
                ],
            )? == 1;
                if changed {
                    changed_roots.insert(payoff.foreshadow_id.clone());
                    changed_paths
                        .entry(payoff.foreshadow_id.clone())
                        .or_default()
                        .insert("/payoff/anchor".to_string());
                }
            }

            let valid_setup_ids: HashSet<&str> =
                setups.iter().map(|setup| setup.id.as_str()).collect();
            let existing_scene_setups = {
                let mut stmt = conn.prepare(
                    "SELECT id, foreshadow_id, is_orphan
                   FROM foreshadow_setups WHERE scene_id = ?1",
                )?;
                let rows = stmt
                    .query_map(params![scene_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                rows
            };
            let allow_bulk_orphan = !setups.is_empty() || doc_content_size <= 2;
            if allow_bulk_orphan {
                for (setup_id, foreshadow_id, is_orphan) in existing_scene_setups {
                    if !valid_setup_ids.contains(setup_id.as_str()) && is_orphan != 1 {
                        if !before_roots.contains_key(&foreshadow_id) {
                            before_roots.insert(
                                foreshadow_id.clone(),
                                load_foreshadow_row_in_tx(conn, &foreshadow_id)?,
                            );
                        }
                        let changed = conn.execute(
                            "UPDATE foreshadow_setups
                            SET is_orphan = 1, updated_at = ?1
                          WHERE id = ?2 AND is_orphan IS NOT 1",
                            params![now, setup_id],
                        )? == 1;
                        if changed {
                            changed_roots.insert(foreshadow_id.clone());
                            changed_paths
                                .entry(foreshadow_id.clone())
                                .or_default()
                                .insert(format!(
                                    "/setups/{}/orphan",
                                    json_pointer_segment(&setup_id)
                                ));
                        }
                        touched_roots.insert(foreshadow_id);
                    }
                }
            }

            let mut authoritative = Vec::with_capacity(touched_roots.len());
            let mut feed_events = Vec::new();
            let mut feed_project_id = None;
            for foreshadow_id in touched_roots {
                let expected_base_version =
                    *base_versions.get(&foreshadow_id).ok_or_else(|| {
                        anyhow::anyhow!(
                    "FORESHADOW_VERSION_MISMATCH: scene snapshot has no baseVersion for '{}'",
                    foreshadow_id
                )
                    })?;
                let result = finish_foreshadow_child_write(
                    conn,
                    &foreshadow_id,
                    changed_roots.contains(&foreshadow_id),
                    Some(expected_base_version),
                    now,
                )?;
                let root_project_id: String = conn.query_row(
                    "SELECT project_id FROM foreshadows WHERE id = ?1",
                    params![foreshadow_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    root_project_id == project_id,
                    "foreshadow anchor save root cannot cross projects"
                );
                if let Some(expected_project_id) = feed_project_id.as_deref() {
                    anyhow::ensure!(
                        expected_project_id == root_project_id,
                        "foreshadow anchor save cannot span projects"
                    );
                } else {
                    feed_project_id = Some(root_project_id.clone());
                }
                record_manual_foreshadow_fields(
                    conn,
                    &root_project_id,
                    &foreshadow_id,
                    &["/setups", "/payoffs"],
                    now,
                )?;
                if changed_roots.contains(&foreshadow_id) {
                    let before = before_roots.get(&foreshadow_id).ok_or_else(|| {
                        anyhow::anyhow!(
                            "foreshadow anchor save missing before snapshot for '{foreshadow_id}'"
                        )
                    })?;
                    let paths = changed_paths
                        .remove(&foreshadow_id)
                        .unwrap_or_else(|| BTreeSet::from(["/setups".to_string()]))
                        .into_iter()
                        .collect();
                    feed_events.push(foreshadow_root_feed_event(
                        &foreshadow_id,
                        "association",
                        "update",
                        Some(before),
                        Some(&result),
                        paths,
                    )?);
                }
                authoritative.push(result);
            }
            if !feed_events.is_empty() {
                let project_id = feed_project_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("foreshadow anchor save project is missing"))?;
                let entity_id = feed_events[0]
                    .object_key
                    .get("foreshadowId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("foreshadow anchor Feed root is missing"))?
                    .to_string();
                let transaction_id = append_foreshadow_feed_with_authority(
                    conn,
                    ForeshadowFeedAppend {
                        project_id,
                        operation: "foreshadow.anchors.save",
                        entity_id: &entity_id,
                        context: &write_context,
                        undo_journal_id: None,
                        events: feed_events,
                    },
                    renderer_context.as_ref(),
                )?;
                authoritative = authoritative
                    .into_iter()
                    .map(|row| attach_maintenance_transaction_id(row, transaction_id.clone()))
                    .collect();
            }
            Ok(Value::Array(authoritative))
        },
    )?;
    serde_json::from_value(value).map_err(Into::into)
}

pub fn load_anchors_for_scene(
    db: &Database,
    scene_id: String,
) -> anyhow::Result<Vec<AnchorMarkOutput>> {
    let setup_rows = db.execute(
        "SELECT setup.id, setup.foreshadow_id, setup.from_pos, setup.to_pos,
                foreshadow.version
         FROM foreshadow_setups setup
         JOIN foreshadows foreshadow ON foreshadow.id = setup.foreshadow_id
         WHERE setup.scene_id = ? AND setup.is_orphan = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT id, payoff_from_pos, payoff_to_pos, version
         FROM foreshadows
         WHERE payoff_scene_id = ?",
        &[Value::String(scene_id)],
        "all",
    )?;

    let mut out = Vec::new();
    for row in setup_rows {
        let from = row.get("from_pos").and_then(|v| v.as_i64()).unwrap_or(0);
        let to = row.get("to_pos").and_then(|v| v.as_i64()).unwrap_or(0);
        if from <= 0 || to <= 0 {
            continue;
        }
        let setup_id = row
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let foreshadow_id = row
            .get("foreshadow_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let base_version = row.get("version").and_then(Value::as_i64).unwrap_or(0);
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowSetup".to_string(),
            attrs: serde_json::json!({
                "setupId": setup_id,
                "foreshadowId": foreshadow_id,
                "baseVersion": base_version,
            }),
        });
    }
    for row in payoff_rows {
        let from = row
            .get("payoff_from_pos")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let to = row
            .get("payoff_to_pos")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if from <= 0 || to <= 0 {
            continue;
        }
        let foreshadow_id = row
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let base_version = row.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowPayoff".to_string(),
            attrs: serde_json::json!({
                "foreshadowId": foreshadow_id,
                "baseVersion": base_version,
            }),
        });
    }
    Ok(out)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        crate::test_support::current_schema_memory().expect("current schema fixture")
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

    fn table_count(db: &Database, table: &str) -> i64 {
        db.with_conn(|conn| {
            let sql = format!("SELECT COUNT(*) FROM {table}");
            conn.query_row(&sql, [], |row| row.get(0))
                .map_err(Into::into)
        })
        .expect("count table")
    }

    fn insert_foreshadow(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadows (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES (?, ?, 'Test', 0, 0, 0, ?, ?)",
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

    fn foreshadow_version(db: &Database, id: &str) -> i64 {
        db.execute(
            "SELECT version FROM foreshadows WHERE id = ?",
            &[Value::String(id.to_string())],
            "get",
        )
        .expect("load foreshadow version")[0]["version"]
            .as_i64()
            .expect("integer foreshadow version")
    }

    fn base_versions(entries: &[(&str, i64)]) -> HashMap<String, i64> {
        entries
            .iter()
            .map(|(id, version)| ((*id).to_string(), *version))
            .collect()
    }

    fn test_write_context() -> RendererWriteContext {
        RendererWriteContext::default()
    }

    fn test_write_context_with(
        request_id: &str,
        session_id: &str,
        event_uid: &str,
    ) -> RendererWriteContext {
        RendererWriteContext {
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            event_uid: event_uid.to_string(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
        }
    }

    fn codex_link_payload(
        project_id: &str,
        foreshadow_id: String,
        codex_id: String,
        base_version: i64,
    ) -> ForeshadowCodexLinkPayload {
        ForeshadowCodexLinkPayload {
            foreshadow_id,
            codex_id,
            project_id: project_id.to_string(),
            base_version,
            context: test_write_context(),
        }
    }

    fn delete_payload(
        project_id: String,
        id: String,
        base_version: i64,
    ) -> ForeshadowDeletePayload {
        ForeshadowDeletePayload {
            id,
            project_id,
            base_version,
            context: test_write_context(),
        }
    }

    fn anchor_save_payload(
        project_id: String,
        scene_id: String,
        setups: Vec<SetupAnchorInput>,
        payoffs: Vec<PayoffAnchorInput>,
        base_versions: HashMap<String, i64>,
        doc_content_size: i64,
    ) -> ForeshadowAnchorSavePayload {
        ForeshadowAnchorSavePayload {
            scene_id,
            project_id,
            setups,
            payoffs,
            base_versions,
            doc_content_size,
            context: test_write_context(),
        }
    }

    fn save_test_anchors(
        db: &Database,
        project_id: String,
        scene_id: String,
        setups: Vec<SetupAnchorInput>,
        payoffs: Vec<PayoffAnchorInput>,
        base_versions: HashMap<String, i64>,
        doc_content_size: i64,
    ) -> anyhow::Result<Vec<Value>> {
        save_anchors_for_scene(
            db,
            anchor_save_payload(
                project_id,
                scene_id,
                setups,
                payoffs,
                base_versions,
                doc_content_size,
            ),
        )
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

    fn insert_folder(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES (?, ?, 'folder', 'Folder', 'a0')",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert folder");
        id
    }

    fn seed_payoff_anchor(
        db: &Database,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
    ) {
        db.execute(
            "UPDATE foreshadows
                SET payoff_scene_id = ?, payoff_from_pos = ?, payoff_to_pos = ?
              WHERE id = ?",
            &[
                Value::String(scene_id.to_string()),
                Value::Number(from_pos.into()),
                Value::Number(to_pos.into()),
                Value::String(foreshadow_id.to_string()),
            ],
            "run",
        )
        .expect("seed payoff anchor");
    }

    fn insert_codex_entry(db: &Database, project_id: &str) -> String {
        let type_id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
             VALUES (?, ?, 'character', 'Character')",
            &[
                Value::String(type_id),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert Codex type");
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES (?, ?, 'character', 'Entry')",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert Codex entry");
        id
    }

    fn insert_setup(
        db: &Database,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
        is_orphan: bool,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let semantic_key = setup_semantic_key(foreshadow_id, scene_id, from_pos, to_pos);
        insert_setup_with_semantic_key(
            db,
            id,
            foreshadow_id,
            scene_id,
            from_pos,
            to_pos,
            is_orphan,
            semantic_key,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_setup_with_semantic_key(
        db: &Database,
        id: String,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
        is_orphan: bool,
        semantic_key: String,
    ) -> String {
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadow_setups
             (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution,
              is_orphan, semantic_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', ?, ?, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(foreshadow_id.to_string()),
                Value::String(scene_id.to_string()),
                Value::Number(from_pos.into()),
                Value::Number(to_pos.into()),
                Value::Bool(is_orphan),
                Value::String(semantic_key),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert setup");
        id
    }

    fn setup_create_ai_input(
        project_id: &str,
        id: &str,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
    ) -> SetupCreateAiInput {
        SetupCreateAiInput {
            context: test_write_context(),
            project_id: project_id.to_string(),
            id: id.to_string(),
            foreshadow_id: foreshadow_id.to_string(),
            base_version: 0,
            scene_id: scene_id.to_string(),
            from_pos,
            to_pos,
            kind: "inserted_new".to_string(),
            strength: None,
            ai_strength: None,
            attribution: "ai".to_string(),
            ai_rationale: None,
            ai_reasoning: None,
            last_evaluated_at: None,
        }
    }

    // ── update ────────────────────────────────────────────────────────

    #[test]
    fn link_codex_rejects_cross_project_association() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let local_codex_id = insert_codex_entry(&db, &project_id);
        let foreign_codex_id = insert_codex_entry(&db, &foreign_project_id);

        link_codex(
            &db,
            codex_link_payload(
                &project_id,
                foreshadow_id.clone(),
                local_codex_id.clone(),
                0,
            ),
        )
        .expect("same-project link");
        let error = link_codex(
            &db,
            codex_link_payload(&project_id, foreshadow_id.clone(), foreign_codex_id, 1),
        )
        .expect_err("cross-project link must be rejected");
        assert!(error.to_string().contains("within one project"));

        let rows = db
            .execute(
                "SELECT codex_entry_id FROM foreshadow_codex_links WHERE foreshadow_id = ?",
                &[Value::String(foreshadow_id)],
                "all",
            )
            .expect("load links");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["codex_entry_id"], Value::String(local_codex_id));
    }

    #[test]
    fn unlink_codex_deletes_only_the_exact_pair_and_can_clean_legacy_cross_project_link() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let first_foreshadow_id = insert_foreshadow(&db, &project_id);
        let second_foreshadow_id = insert_foreshadow(&db, &project_id);
        let local_codex_id = insert_codex_entry(&db, &project_id);
        let foreign_codex_id = insert_codex_entry(&db, &foreign_project_id);
        link_codex(
            &db,
            codex_link_payload(
                &project_id,
                first_foreshadow_id.clone(),
                local_codex_id.clone(),
                0,
            ),
        )
        .expect("first local link");
        link_codex(
            &db,
            codex_link_payload(
                &project_id,
                second_foreshadow_id.clone(),
                local_codex_id.clone(),
                0,
            ),
        )
        .expect("second local link");
        db.execute(
            "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
             VALUES (?, ?)",
            &[
                Value::String(first_foreshadow_id.clone()),
                Value::String(foreign_codex_id.clone()),
            ],
            "run",
        )
        .expect("insert legacy cross-project link fixture");

        unlink_codex(
            &db,
            codex_link_payload(
                &project_id,
                first_foreshadow_id.clone(),
                local_codex_id.clone(),
                1,
            ),
        )
        .expect("unlink exact local pair");
        let surviving_local = db
            .execute(
                "SELECT 1 AS present FROM foreshadow_codex_links
                  WHERE foreshadow_id = ? AND codex_entry_id = ?",
                &[
                    Value::String(second_foreshadow_id),
                    Value::String(local_codex_id),
                ],
                "all",
            )
            .expect("load other root link");
        assert_eq!(surviving_local.len(), 1);

        unlink_codex(
            &db,
            codex_link_payload(
                &project_id,
                first_foreshadow_id.clone(),
                foreign_codex_id.clone(),
                2,
            ),
        )
        .expect("legacy invalid pair should remain removable");
        let legacy = db
            .execute(
                "SELECT 1 AS present FROM foreshadow_codex_links
                  WHERE foreshadow_id = ? AND codex_entry_id = ?",
                &[
                    Value::String(first_foreshadow_id),
                    Value::String(foreign_codex_id),
                ],
                "all",
            )
            .expect("load legacy link after cleanup");
        assert!(legacy.is_empty());
    }

    #[test]
    fn update_impl_no_fields_returns_existing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["id"], Value::String(fid));
        assert_eq!(result["version"], Value::Number(0.into()));
    }

    #[test]
    fn update_impl_single_field_updates_title() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: Some("新タイトル".to_string()),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["title"], Value::String("新タイトル".to_string()));
        assert_eq!(result["version"], Value::Number(1.into()));
    }

    #[test]
    fn update_impl_null_clear_intent() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        // Set intent first
        let set_patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: None,
            intent: Some(Some("intent".to_string())),
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        update(&db, fid.clone(), set_patch).unwrap();

        // Now clear it with Some(None)
        let clear_patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 1,
            title: None,
            intent: Some(None),
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };
        let result = update(&db, fid.clone(), clear_patch).unwrap();
        assert_eq!(result["intent"], Value::Null);
        assert_eq!(result["version"], Value::Number(2.into()));
    }

    #[test]
    fn nullable_patch_deserialization_distinguishes_omitted_from_explicit_null() {
        let omitted: ForeshadowPatch = serde_json::from_value(serde_json::json!({
            "projectId": "p1",
            "requestId": "nullable-root-omitted",
            "sessionId": "nullable-session",
            "eventUid": "nullable-root-omitted",
            "origin": "human",
            "baseVersion": 0,
        }))
        .expect("deserialize omitted patch");
        assert!(omitted.intent.is_none());
        assert!(omitted.notes.is_none());
        assert!(omitted.payoff_scene_id.is_none());
        assert!(omitted.payoff_from_pos.is_none());
        assert!(omitted.payoff_to_pos.is_none());
        assert!(omitted.load_bearing.is_none());

        let cleared: ForeshadowPatch = serde_json::from_value(serde_json::json!({
            "projectId": "p1",
            "requestId": "nullable-root-cleared",
            "sessionId": "nullable-session",
            "eventUid": "nullable-root-cleared",
            "origin": "human",
            "baseVersion": 0,
            "intent": null,
            "notes": null,
            "payoffSceneId": null,
            "payoffFromPos": null,
            "payoffToPos": null,
            "loadBearing": null,
        }))
        .expect("deserialize explicit null patch");
        assert_eq!(cleared.intent, Some(None));
        assert_eq!(cleared.notes, Some(None));
        assert_eq!(cleared.payoff_scene_id, Some(None));
        assert_eq!(cleared.payoff_from_pos, Some(None));
        assert_eq!(cleared.payoff_to_pos, Some(None));
        assert_eq!(cleared.load_bearing, Some(None));

        let setup_omitted: ForeshadowSetupPatch = serde_json::from_value(serde_json::json!({
            "projectId": "p1",
            "requestId": "nullable-setup-omitted",
            "sessionId": "nullable-session",
            "eventUid": "nullable-setup-omitted",
            "origin": "human",
            "baseVersion": 0
        }))
        .expect("deserialize omitted setup patch");
        assert!(setup_omitted.strength.is_none());
        assert!(setup_omitted.ai_reasoning.is_none());
        assert!(setup_omitted.last_evaluated_at.is_none());

        let setup_cleared: ForeshadowSetupPatch = serde_json::from_value(serde_json::json!({
            "projectId": "p1",
            "requestId": "nullable-setup-cleared",
            "sessionId": "nullable-session",
            "eventUid": "nullable-setup-cleared",
            "origin": "human",
            "baseVersion": 0,
            "strength": null,
            "aiReasoning": null,
            "lastEvaluatedAt": null,
        }))
        .expect("deserialize explicit-null setup patch");
        assert_eq!(setup_cleared.strength, Some(None));
        assert_eq!(setup_cleared.ai_reasoning, Some(None));
        assert_eq!(setup_cleared.last_evaluated_at, Some(None));
    }

    #[test]
    fn stale_root_update_and_delete_are_atomic_nonmutating() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);

        update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: Some("fresh title".to_string()),
                intent: None,
                notes: None,
                payoff_scene_id: None,
                payoff_from_pos: None,
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect("first window update");

        let stale_update = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: Some("stale title".to_string()),
                intent: None,
                notes: None,
                payoff_scene_id: None,
                payoff_from_pos: None,
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("second window stale update must conflict");
        assert!(stale_update
            .to_string()
            .contains("FORESHADOW_VERSION_MISMATCH"));

        let stale_delete = delete(&db, delete_payload(project_id, foreshadow_id.clone(), 0))
            .expect_err("second window stale delete must conflict");
        assert!(stale_delete
            .to_string()
            .contains("FORESHADOW_VERSION_MISMATCH"));

        let row = db
            .execute(
                "SELECT title, version FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load surviving root");
        assert_eq!(row[0]["title"], "fresh title");
        assert_eq!(row[0]["version"], 1);
        let journal = db
            .execute(
                "SELECT COUNT(*) AS count FROM undo_journal WHERE entity_kind = 'foreshadow'",
                &[],
                "get",
            )
            .expect("load journal count");
        assert_eq!(journal[0]["count"], 1);
    }

    #[test]
    fn mark_linked_codex_dirty_advances_only_matching_project_roots() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let linked_id = insert_foreshadow(&db, &project_id);
        let unlinked_id = insert_foreshadow(&db, &project_id);
        let foreign_id = insert_foreshadow(&db, &foreign_project_id);
        let codex_id = insert_codex_entry(&db, &project_id);
        link_codex(
            &db,
            ForeshadowCodexLinkPayload {
                foreshadow_id: linked_id.clone(),
                codex_id: codex_id.clone(),
                project_id: project_id.clone(),
                base_version: 0,
                context: RendererWriteContext::default(),
            },
        )
        .expect("link local root");
        db.execute(
            "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
             VALUES (?, ?)",
            &[
                Value::String(foreign_id.clone()),
                Value::String(codex_id.clone()),
            ],
            "insert legacy foreign link fixture",
        )
        .expect("insert legacy foreign link fixture");

        mark_linked_codex_dirty(&db, project_id.clone(), codex_id.clone())
            .expect("mark matching roots dirty");
        mark_linked_codex_dirty(&db, project_id, codex_id)
            .expect("a second successful mutation advances again");

        let rows = db
            .execute(
                "SELECT id, version, codex_link_dirty_at FROM foreshadows
                 WHERE id IN (?, ?, ?) ORDER BY id",
                &[
                    Value::String(linked_id.clone()),
                    Value::String(unlinked_id.clone()),
                    Value::String(foreign_id.clone()),
                ],
                "all",
            )
            .expect("load root versions");
        let by_id: std::collections::HashMap<&str, &serde_json::Map<String, Value>> = rows
            .iter()
            .map(|row| (row["id"].as_str().expect("id"), row))
            .collect();
        assert_eq!(
            by_id[linked_id.as_str()]["version"],
            Value::Number(3.into())
        );
        assert!(by_id[linked_id.as_str()]["codex_link_dirty_at"].is_number());
        assert_eq!(
            by_id[unlinked_id.as_str()]["version"],
            Value::Number(0.into())
        );
        assert_eq!(
            by_id[foreign_id.as_str()]["version"],
            Value::Number(0.into())
        );
    }

    #[test]
    fn stale_child_writes_roll_back_without_mutating_children() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        let setup_id = insert_setup(&db, &foreshadow_id, &scene_id, 1, 5, false);
        let codex_id = insert_codex_entry(&db, &project_id);

        let first = update_setup(
            &db,
            setup_id.clone(),
            ForeshadowSetupPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                strength: Some(Some("strong".to_string())),
                ai_strength: None,
                ai_reasoning: None,
                is_orphan: None,
                last_evaluated_at: None,
            },
        )
        .expect("first window child update");
        assert_eq!(first["version"], 1);

        update_setup(
            &db,
            setup_id.clone(),
            ForeshadowSetupPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                strength: Some(Some("weak".to_string())),
                ai_strength: None,
                ai_reasoning: None,
                is_orphan: None,
                last_evaluated_at: None,
            },
        )
        .expect_err("stale setup update must conflict");
        link_codex(
            &db,
            codex_link_payload(&project_id, foreshadow_id.clone(), codex_id.clone(), 0),
        )
        .expect_err("stale link must conflict and roll back");
        save_anchors_for_scene(
            &db,
            anchor_save_payload(
                project_id.clone(),
                scene_id.clone(),
                vec![SetupAnchorInput {
                    id: setup_id.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos: 2,
                    to_pos: 6,
                }],
                vec![],
                base_versions(&[(&foreshadow_id, 0)]),
                20,
            ),
        )
        .expect_err("stale anchor save must conflict and roll back");
        resolve_orphan(
            &db,
            OrphanResolvePayload {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                setup_id: setup_id.clone(),
                base_version: 0,
                action: "delete".to_string(),
                scene_id: None,
                from_pos: None,
                to_pos: None,
            },
        )
        .expect_err("stale child delete must conflict and roll back");

        let setup = db
            .execute(
                "SELECT strength, from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = ?",
                &[Value::String(setup_id)],
                "get",
            )
            .expect("load setup after stale writers");
        assert_eq!(setup[0]["strength"], "strong");
        assert_eq!(setup[0]["from_pos"], 1);
        assert_eq!(setup[0]["to_pos"], 5);
        assert_eq!(setup[0]["is_orphan"], 0);
        let links = db
            .execute(
                "SELECT COUNT(*) AS count FROM foreshadow_codex_links
                  WHERE foreshadow_id = ? AND codex_entry_id = ?",
                &[
                    Value::String(foreshadow_id.clone()),
                    Value::String(codex_id),
                ],
                "get",
            )
            .expect("load links after stale writer");
        assert_eq!(links[0]["count"], 0);
        assert_eq!(foreshadow_version(&db, &foreshadow_id), 1);
    }

    // ── load_bearing 軸（Phase 6） ─────────────────────────────────────

    #[test]
    fn validate_load_bearing_accepts_known_values_and_null() {
        assert!(validate_load_bearing(None).is_ok());
        assert!(validate_load_bearing(Some("critical")).is_ok());
        assert!(validate_load_bearing(Some("supporting")).is_ok());
        assert!(validate_load_bearing(Some("optional")).is_ok());
    }

    #[test]
    fn validate_load_bearing_rejects_unknown_values() {
        assert!(validate_load_bearing(Some("")).is_err());
        assert!(validate_load_bearing(Some("Critical")).is_err());
        assert!(validate_load_bearing(Some("required")).is_err());
        assert!(validate_load_bearing(Some("'; DROP TABLE foreshadows --")).is_err());
    }

    #[test]
    fn create_impl_persists_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            context: test_write_context(),
            id: None,
            project_id: proj.clone(),
            title: "T".to_string(),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: false,
            abandoned: false,
            secret: true,
            load_bearing: Some("critical".to_string()),
            codex_link_dirty_at: None,
        };
        let row = create(&db, payload).unwrap();
        assert_eq!(row["load_bearing"], Value::String("critical".to_string()));
    }

    #[test]
    fn create_is_idempotent_by_client_id_and_conflicts_on_payload_change() {
        let db = test_db();
        let proj = insert_project(&db);
        let payoff_scene_id = insert_scene(&db, &proj);
        let payload = ForeshadowCreatePayload {
            context: test_write_context_with(
                "foreshadow-ui-request-1",
                "foreshadow-renderer-session",
                "foreshadow-create-event",
            ),
            id: Some("foreshadow-entity-1".to_string()),
            project_id: proj.clone(),
            title: "SECRET_FORESHADOW_SENTINEL".to_string(),
            intent: Some("private manuscript intent".to_string()),
            notes: Some("restore every field".to_string()),
            payoff_scene_id: Some(payoff_scene_id.clone()),
            payoff_from_pos: Some(4),
            payoff_to_pos: Some(12),
            payoff_confirmed: true,
            abandoned: true,
            secret: false,
            load_bearing: Some("critical".to_string()),
            codex_link_dirty_at: Some(1_784_000_000_000),
        };
        let first = create(&db, payload.clone()).expect("first create");
        assert_eq!(
            first["notes"],
            Value::String("restore every field".to_string())
        );
        assert_eq!(first["payoff_scene_id"], Value::String(payoff_scene_id));
        assert_eq!(first["payoff_from_pos"], Value::Number(4.into()));
        assert_eq!(first["payoff_to_pos"], Value::Number(12.into()));
        assert_eq!(first["payoff_confirmed"], Value::Number(1.into()));
        assert_eq!(first["abandoned"], Value::Number(1.into()));
        assert_eq!(first["secret"], Value::Number(0.into()));
        assert_eq!(
            first["codex_link_dirty_at"],
            Value::Number(1_784_000_000_000_i64.into())
        );
        let ledger = db
            .execute(
                "SELECT tombstone_json FROM idempotency_requests
                  WHERE domain = 'foreshadow_create'
                    AND request_id = 'foreshadow-ui-request-1'",
                &[],
                "get",
            )
            .expect("read ledger");
        let tombstone = ledger[0]["tombstone_json"].as_str().expect("tombstone");
        assert!(!tombstone.contains("SECRET_FORESHADOW_SENTINEL"));
        assert!(!tombstone.contains("private manuscript"));
        let retry = create(&db, payload.clone()).expect("exact retry");
        assert_eq!(retry["id"], first["id"]);
        assert_eq!(first["__idempotency"]["replayed"], Value::Bool(false));
        assert_eq!(retry["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(retry["__idempotency"]["entityPresent"], Value::Bool(true));
        let tracked: (i64, String, String, String, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*), tx.origin, tx.request_id,
                            event.event_uid, event.session_id
                       FROM narrative_change_transactions tx
                       JOIN change_events event
                         ON event.project_id = tx.project_id
                        AND event.event_uid = tx.source_change_event_uid
                      WHERE tx.project_id = ?1
                        AND tx.source_domain = 'foreshadow.create'",
                    params![proj],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(Into::into)
            })
            .expect("load tracked create identity");
        assert_eq!(
            tracked,
            (
                1,
                "human".to_string(),
                "foreshadow-ui-request-1".to_string(),
                "foreshadow-create-event".to_string(),
                "foreshadow-renderer-session".to_string(),
            )
        );

        let mut cross_session_retry = payload.clone();
        cross_session_retry.context.session_id = "foreshadow-retry-session".to_string();
        cross_session_retry.context.event_uid = "foreshadow-retry-event".to_string();
        let cross_session_replay =
            create(&db, cross_session_retry).expect("cross-session exact retry");
        assert_eq!(
            cross_session_replay["__idempotency"]["replayed"],
            Value::Bool(true)
        );
        assert_eq!(table_count(&db, "change_events"), 1);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);

        delete(
            &db,
            delete_payload(proj.clone(), "foreshadow-entity-1".to_string(), 0),
        )
        .expect("delete entity");
        let deleted_retry = create(&db, payload.clone()).expect("retry after delete");
        assert_eq!(deleted_retry["id"], first["id"]);
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );

        let mut conflicting = payload.clone();
        conflicting.title = "Changed".to_string();
        let error = create(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT"));
        let rows = db
            .execute(
                "SELECT COUNT(*) AS n FROM foreshadows WHERE id = ?",
                &[Value::String("foreshadow-entity-1".to_string())],
                "get",
            )
            .expect("count row");
        assert_eq!(rows[0]["n"].as_i64(), Some(0));

        let deliberate_restore = ForeshadowCreatePayload {
            context: test_write_context_with(
                "foreshadow-history-restore-1",
                "foreshadow-history-session",
                "foreshadow-history-restore-1",
            ),
            id: Some("foreshadow-entity-1".to_string()),
            project_id: proj,
            title: "SECRET_FORESHADOW_SENTINEL".to_string(),
            intent: Some("private manuscript intent".to_string()),
            notes: Some("restore every field".to_string()),
            payoff_scene_id: payload.payoff_scene_id,
            payoff_from_pos: Some(4),
            payoff_to_pos: Some(12),
            payoff_confirmed: true,
            abandoned: true,
            secret: false,
            load_bearing: Some("critical".to_string()),
            codex_link_dirty_at: Some(1_784_000_000_000),
        };
        // Tombstones intentionally contain only `id`; use the original
        // semantic payload while changing only the request identity.
        let restored = create(&db, deliberate_restore).expect("deliberate history restore");
        assert_eq!(restored["id"], first["id"]);
        assert_eq!(
            restored["__idempotency"]["entityPresent"],
            Value::Bool(true)
        );
        assert_eq!(restored["__idempotency"]["replayed"], Value::Bool(false));
    }

    #[test]
    fn create_feed_failure_rolls_back_domain_canonical_and_request_ledger() {
        let db = test_db();
        let project_id = insert_project(&db);
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TRIGGER reject_foreshadow_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced foreshadow Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install Feed failure trigger");

        let error = create(
            &db,
            ForeshadowCreatePayload {
                context: test_write_context_with(
                    "rollback-request",
                    "rollback-session",
                    "rollback-event",
                ),
                id: Some("rollback-foreshadow".to_string()),
                project_id,
                title: "Rollback".to_string(),
                intent: None,
                notes: None,
                payoff_scene_id: None,
                payoff_from_pos: None,
                payoff_to_pos: None,
                payoff_confirmed: false,
                abandoned: false,
                secret: true,
                load_bearing: None,
                codex_link_dirty_at: None,
            },
        )
        .expect_err("Feed failure must abort the writer transaction");
        assert!(error.to_string().contains("forced foreshadow Feed failure"));
        assert_eq!(table_count(&db, "foreshadows"), 0);
        assert_eq!(table_count(&db, "change_events"), 0);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 0);
        assert_eq!(table_count(&db, "idempotency_requests"), 0);
    }

    #[test]
    fn create_request_id_without_entity_id_replays_the_same_generated_entity() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            context: test_write_context_with(
                "foreshadow-request-only",
                "foreshadow-request-only-session",
                "foreshadow-request-only",
            ),
            id: None,
            project_id,
            title: "Request-only identity".to_string(),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: false,
            abandoned: false,
            secret: true,
            load_bearing: None,
            codex_link_dirty_at: None,
        };

        let first = create(&db, payload.clone()).expect("first create");
        let replay = create(&db, payload).expect("exact replay");
        assert_eq!(
            first["id"],
            Value::String("foreshadow-request-only".to_string())
        );
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(replay["__idempotency"]["entityPresent"], Value::Bool(true));
    }

    #[test]
    fn create_rejects_invalid_or_cross_project_payoff_anchors_atomically() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let base = ForeshadowCreatePayload {
            context: test_write_context_with(
                "foreshadow-payoff-validation",
                "foreshadow-payoff-validation-session",
                "foreshadow-payoff-validation",
            ),
            id: Some("foreshadow-payoff-validation".to_string()),
            project_id: project_id.clone(),
            title: "Invalid payoff".to_string(),
            intent: None,
            notes: None,
            payoff_scene_id: Some(foreign_scene_id),
            payoff_from_pos: Some(1),
            payoff_to_pos: Some(2),
            payoff_confirmed: false,
            abandoned: false,
            secret: true,
            load_bearing: None,
            codex_link_dirty_at: None,
        };

        let error = create(&db, base.clone()).expect_err("cross-project payoff");
        assert!(error.to_string().contains("same project"));
        let ledger = db
            .execute(
                "SELECT request_id FROM idempotency_requests WHERE request_id = ?",
                &[Value::String("foreshadow-payoff-validation".to_string())],
                "all",
            )
            .expect("read ledger");
        assert!(ledger.is_empty());

        let local_scene_id = insert_scene(&db, &project_id);
        let invalid_range = ForeshadowCreatePayload {
            context: test_write_context_with(
                "foreshadow-payoff-range",
                "foreshadow-payoff-range-session",
                "foreshadow-payoff-range",
            ),
            id: Some("foreshadow-payoff-range".to_string()),
            payoff_scene_id: Some(local_scene_id),
            payoff_from_pos: Some(9),
            payoff_to_pos: Some(3),
            ..base
        };
        let error = create(&db, invalid_range).expect_err("invalid payoff range");
        assert!(error.to_string().contains("0 <= from <= to"));
    }

    #[test]
    fn create_rejects_same_project_folder_as_payoff_scene_atomically() {
        let db = test_db();
        let project_id = insert_project(&db);
        let folder_id = insert_folder(&db, &project_id);
        let error = create(
            &db,
            ForeshadowCreatePayload {
                context: test_write_context_with(
                    "foreshadow-folder-payoff",
                    "foreshadow-folder-payoff-session",
                    "foreshadow-folder-payoff",
                ),
                id: Some("foreshadow-folder-payoff".to_string()),
                project_id,
                title: "Invalid folder payoff".to_string(),
                intent: None,
                notes: None,
                payoff_scene_id: Some(folder_id),
                payoff_from_pos: Some(1),
                payoff_to_pos: Some(2),
                payoff_confirmed: false,
                abandoned: false,
                secret: true,
                load_bearing: None,
                codex_link_dirty_at: None,
            },
        )
        .expect_err("folder payoff must be rejected");
        assert!(error.to_string().contains("same project scene"));

        let rows = db
            .execute(
                "SELECT COUNT(*) AS count FROM foreshadows
                  WHERE id = 'foreshadow-folder-payoff'",
                &[],
                "get",
            )
            .expect("count rejected foreshadow");
        assert_eq!(rows[0]["count"], 0);
        let ledger = db
            .execute(
                "SELECT COUNT(*) AS count FROM idempotency_requests
                  WHERE request_id = 'foreshadow-folder-payoff'",
                &[],
                "get",
            )
            .expect("count rejected idempotency ledger");
        assert_eq!(ledger[0]["count"], 0);
    }

    #[test]
    fn update_rejects_a_cross_project_payoff_scene() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: project_id.clone(),
            base_version: 0,
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: Some(Some(foreign_scene_id)),
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: None,
        };

        let error = update(&db, foreshadow_id.clone(), patch).expect_err("cross-project payoff");
        assert!(error.to_string().contains("same project"));
        let persisted = db
            .execute(
                "SELECT payoff_scene_id FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("read foreshadow");
        assert_eq!(persisted[0]["payoff_scene_id"], Value::Null);
    }

    #[test]
    fn update_rejects_clearing_payoff_scene_while_positions_remain_atomically() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        seed_payoff_anchor(&db, &foreshadow_id, &scene_id, 10, 20);

        let error = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: Some("must roll back".to_string()),
                intent: None,
                notes: None,
                payoff_scene_id: Some(None),
                payoff_from_pos: None,
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("scene clear with retained positions must reject");
        assert!(error.to_string().contains("require a payoff scene"));

        let rows = db
            .execute(
                "SELECT title, payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                   FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load unchanged foreshadow");
        assert_eq!(rows[0]["title"], "Test");
        assert_eq!(rows[0]["payoff_scene_id"], scene_id);
        assert_eq!(rows[0]["payoff_from_pos"], 10);
        assert_eq!(rows[0]["payoff_to_pos"], 20);
        assert_eq!(rows[0]["version"], 0);
    }

    #[test]
    fn update_rejects_partial_position_patches_against_effective_tuple() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        seed_payoff_anchor(&db, &foreshadow_id, &scene_id, 10, 20);

        let invalid_range = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                payoff_scene_id: None,
                payoff_from_pos: Some(Some(30)),
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("effective from > to must reject");
        assert!(invalid_range.to_string().contains("0 <= from <= to"));

        let half_null = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                payoff_scene_id: None,
                payoff_from_pos: Some(None),
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("one null position must reject");
        assert!(half_null.to_string().contains("both be null"));

        let rows = db
            .execute(
                "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                   FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load unchanged foreshadow");
        assert_eq!(rows[0]["payoff_scene_id"], scene_id);
        assert_eq!(rows[0]["payoff_from_pos"], 10);
        assert_eq!(rows[0]["payoff_to_pos"], 20);
        assert_eq!(rows[0]["version"], 0);
    }

    #[test]
    fn update_rejects_same_project_folder_as_payoff_scene_atomically() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        let folder_id = insert_folder(&db, &project_id);
        seed_payoff_anchor(&db, &foreshadow_id, &scene_id, 10, 20);

        let error = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: Some("must roll back".to_string()),
                intent: None,
                notes: None,
                payoff_scene_id: Some(Some(folder_id)),
                payoff_from_pos: None,
                payoff_to_pos: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("folder payoff must be rejected");
        assert!(error.to_string().contains("same project scene"));

        let rows = db
            .execute(
                "SELECT title, payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                   FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load unchanged foreshadow");
        assert_eq!(rows[0]["title"], "Test");
        assert_eq!(rows[0]["payoff_scene_id"], scene_id);
        assert_eq!(rows[0]["payoff_from_pos"], 10);
        assert_eq!(rows[0]["payoff_to_pos"], 20);
        assert_eq!(rows[0]["version"], 0);
    }

    #[test]
    fn update_accepts_a_valid_payoff_tuple_as_one_cas_mutation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let old_scene_id = insert_scene(&db, &project_id);
        let new_scene_id = insert_scene(&db, &project_id);
        seed_payoff_anchor(&db, &foreshadow_id, &old_scene_id, 10, 20);

        let updated = update(
            &db,
            foreshadow_id.clone(),
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                payoff_scene_id: Some(Some(new_scene_id.clone())),
                payoff_from_pos: Some(Some(30)),
                payoff_to_pos: Some(Some(40)),
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect("valid tuple update");
        assert_eq!(updated["payoff_scene_id"], new_scene_id);
        assert_eq!(updated["payoff_from_pos"], 30);
        assert_eq!(updated["payoff_to_pos"], 40);
        assert_eq!(updated["version"], 1);

        let stale = update(
            &db,
            foreshadow_id,
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                payoff_scene_id: Some(Some(old_scene_id)),
                payoff_from_pos: Some(Some(1)),
                payoff_to_pos: Some(Some(2)),
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect_err("stale payoff tuple update must reject");
        assert!(stale.to_string().contains("FORESHADOW_VERSION_MISMATCH"));
    }

    #[test]
    fn update_accepts_explicitly_clearing_the_entire_payoff_tuple() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        seed_payoff_anchor(&db, &foreshadow_id, &scene_id, 10, 20);

        let updated = update(
            &db,
            foreshadow_id,
            ForeshadowPatch {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                base_version: 0,
                title: None,
                intent: None,
                notes: None,
                payoff_scene_id: Some(None),
                payoff_from_pos: Some(None),
                payoff_to_pos: Some(None),
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
                load_bearing: None,
            },
        )
        .expect("explicit all-null tuple clear");
        assert_eq!(updated["payoff_scene_id"], Value::Null);
        assert_eq!(updated["payoff_from_pos"], Value::Null);
        assert_eq!(updated["payoff_to_pos"], Value::Null);
        assert_eq!(updated["version"], 1);
    }

    #[test]
    fn create_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            context: test_write_context(),
            id: None,
            project_id: proj.clone(),
            title: "T".to_string(),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: false,
            abandoned: false,
            secret: true,
            load_bearing: Some("required".to_string()),
            codex_link_dirty_at: None,
        };
        let result = create(&db, payload);
        assert!(result.is_err(), "invalid load_bearing should reject");

        // バリデーション後の副作用が無いこと（INSERT が実行されていない）を確認
        let rows = db
            .execute(
                "SELECT COUNT(*) AS n FROM foreshadows WHERE project_id = ?",
                &[Value::String(proj)],
                "all",
            )
            .unwrap();
        assert_eq!(rows[0]["n"], Value::Number(0.into()));
    }

    #[test]
    fn update_impl_sets_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("supporting".to_string())),
        };
        let result = update(&db, fid, patch).unwrap();
        assert_eq!(
            result["load_bearing"],
            Value::String("supporting".to_string())
        );
    }

    #[test]
    fn update_impl_clears_load_bearing_with_some_none() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        // まず critical にセット
        let set_patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("critical".to_string())),
        };
        update(&db, fid.clone(), set_patch).unwrap();

        // Some(None) で NULL クリア
        let clear_patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 1,
            title: None,
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(None),
        };
        let result = update(&db, fid, clear_patch).unwrap();
        assert_eq!(result["load_bearing"], Value::Null);
    }

    #[test]
    fn update_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            base_version: 0,
            title: Some("should not apply".to_string()),
            intent: None,
            notes: None,
            payoff_scene_id: None,
            payoff_from_pos: None,
            payoff_to_pos: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
            load_bearing: Some(Some("bogus".to_string())),
        };
        let result = update(&db, fid.clone(), patch);
        assert!(result.is_err(), "invalid load_bearing should reject");

        // 同 patch 内の他フィールドも反映されていないことを確認（早期 return）
        let rows = db
            .execute(
                "SELECT title FROM foreshadows WHERE id = ?",
                &[Value::String(fid)],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["title"], Value::String("Test".to_string()));
    }

    // ── resolve_orphan ────────────────────────────────────────────────

    #[test]
    fn setup_create_ai_rejects_existing_id_rebinding_without_mutation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let original_foreshadow_id = insert_foreshadow(&db, &project_id);
        let other_foreshadow_id = insert_foreshadow(&db, &project_id);
        let original_scene_id = insert_scene(&db, &project_id);
        let other_scene_id = insert_scene(&db, &project_id);
        let setup_id = insert_setup(
            &db,
            &original_foreshadow_id,
            &original_scene_id,
            1,
            5,
            false,
        );

        let foreshadow_error = setup_create_ai(
            &db,
            setup_create_ai_input(
                &project_id,
                &setup_id,
                &other_foreshadow_id,
                &original_scene_id,
                10,
                20,
            ),
        )
        .expect_err("existing setup id must not be rebound to another foreshadow");
        assert!(foreshadow_error.to_string().contains("different anchor"));

        let scene_error = setup_create_ai(
            &db,
            setup_create_ai_input(
                &project_id,
                &setup_id,
                &original_foreshadow_id,
                &other_scene_id,
                10,
                20,
            ),
        )
        .expect_err("AI setup update must keep the original scene identity");
        assert!(scene_error.to_string().contains("different anchor"));

        let rows = db
            .execute(
                "SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
                   FROM foreshadow_setups WHERE id = ?",
                &[Value::String(setup_id)],
                "get",
            )
            .expect("load unchanged setup");
        assert_eq!(
            rows[0]["foreshadow_id"],
            Value::String(original_foreshadow_id.clone())
        );
        assert_eq!(
            rows[0]["scene_id"],
            Value::String(original_scene_id.clone())
        );
        assert_eq!(rows[0]["from_pos"], Value::Number(1.into()));
        assert_eq!(rows[0]["to_pos"], Value::Number(5.into()));
        assert_eq!(
            rows[0]["semantic_key"],
            Value::String(setup_semantic_key(
                &original_foreshadow_id,
                &original_scene_id,
                1,
                5,
            ))
        );

        let foreign_project_id = insert_project(&db);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let cross_project_error = setup_create_ai(
            &db,
            setup_create_ai_input(
                &project_id,
                "cross-project-new-setup",
                &original_foreshadow_id,
                &foreign_scene_id,
                1,
                5,
            ),
        )
        .expect_err("new cross-project setup anchor must be rejected");
        assert!(cross_project_error.to_string().contains("same project"));
        let cross_project_rows = db
            .execute(
                "SELECT id FROM foreshadow_setups WHERE id = 'cross-project-new-setup'",
                &[],
                "all",
            )
            .expect("check rejected cross-project setup");
        assert!(cross_project_rows.is_empty());
    }

    #[test]
    fn setup_create_ai_preserves_matching_legacy_duplicate_key_and_rejects_collision() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        insert_setup(&db, &foreshadow_id, &scene_id, 1, 5, false);
        let duplicate_id = "legacy-duplicate-setup".to_string();
        let natural_key = setup_semantic_key(&foreshadow_id, &scene_id, 1, 5);
        let legacy_key = format!("{natural_key}#dup:{duplicate_id}");
        insert_setup_with_semantic_key(
            &db,
            duplicate_id.clone(),
            &foreshadow_id,
            &scene_id,
            1,
            5,
            false,
            legacy_key.clone(),
        );

        setup_create_ai(
            &db,
            setup_create_ai_input(&project_id, &duplicate_id, &foreshadow_id, &scene_id, 1, 5),
        )
        .expect("unchanged legacy duplicate anchor must retain its suffix");
        let preserved = db
            .execute(
                "SELECT semantic_key FROM foreshadow_setups WHERE id = ?",
                &[Value::String(duplicate_id.clone())],
                "get",
            )
            .expect("load preserved semantic key");
        assert_eq!(preserved[0]["semantic_key"], Value::String(legacy_key));

        setup_create_ai(
            &db,
            setup_create_ai_input(&project_id, &duplicate_id, &foreshadow_id, &scene_id, 6, 10),
        )
        .expect("moving away from a duplicate natural key should use the new natural key");
        let moved_key = setup_semantic_key(&foreshadow_id, &scene_id, 6, 10);
        let moved = db
            .execute(
                "SELECT semantic_key FROM foreshadow_setups WHERE id = ?",
                &[Value::String(duplicate_id.clone())],
                "get",
            )
            .expect("load moved semantic key");
        assert_eq!(moved[0]["semantic_key"], Value::String(moved_key));

        insert_setup(&db, &foreshadow_id, &scene_id, 11, 15, false);
        setup_create_ai(
            &db,
            setup_create_ai_input(
                &project_id,
                &duplicate_id,
                &foreshadow_id,
                &scene_id,
                11,
                15,
            ),
        )
        .expect_err("moving onto another row's natural key must be rejected");
        let after_collision = db
            .execute(
                "SELECT from_pos, to_pos, semantic_key FROM foreshadow_setups WHERE id = ?",
                &[Value::String(duplicate_id)],
                "get",
            )
            .expect("load setup after rejected collision");
        assert_eq!(after_collision[0]["from_pos"], Value::Number(6.into()));
        assert_eq!(after_collision[0]["to_pos"], Value::Number(10.into()));
    }

    #[test]
    fn resolve_orphan_reanchor_missing_scene_id_errors() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            context: RendererWriteContext::default(),
            project_id: "fixture-project".to_string(),
            setup_id: "s-1".to_string(),
            base_version: 0,
            action: "reanchor".to_string(),
            scene_id: None,
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let result = resolve_orphan(&db, payload);
        assert!(
            result.is_err(),
            "reanchor with missing scene_id should error"
        );
    }

    #[test]
    fn resolve_orphan_reanchor_missing_from_pos_errors() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            context: RendererWriteContext::default(),
            project_id: "fixture-project".to_string(),
            setup_id: "s-1".to_string(),
            base_version: 0,
            action: "reanchor".to_string(),
            scene_id: Some("sc-1".to_string()),
            from_pos: None,
            to_pos: Some(20),
        };
        let result = resolve_orphan(&db, payload);
        assert!(result.is_err());
    }

    #[test]
    fn resolve_orphan_reanchor_updates_row() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let old_scene = insert_scene(&db, &proj);
        let new_scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &old_scene, 0, 0, true);

        let payload = OrphanResolvePayload {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            setup_id: sid.clone(),
            base_version: 0,
            action: "reanchor".to_string(),
            scene_id: Some(new_scene.clone()),
            from_pos: Some(5),
            to_pos: Some(15),
        };
        resolve_orphan(&db, payload).unwrap();

        let rows = db
            .execute(
                "SELECT scene_id, from_pos, to_pos, is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        let row = rows.first().unwrap();
        assert_eq!(row["scene_id"], Value::String(new_scene));
        assert_eq!(row["from_pos"], Value::Number(5.into()));
        assert_eq!(row["is_orphan"], Value::Number(0.into()));
    }

    #[test]
    fn resolve_orphan_reinsert_is_atomic_old_deleted_new_created() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 0, 0, true);

        let payload = OrphanResolvePayload {
            context: RendererWriteContext::default(),
            project_id: proj.clone(),
            setup_id: sid.clone(),
            base_version: 0,
            action: "reinsert".to_string(),
            scene_id: Some(scene.clone()),
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let receipt = resolve_orphan(&db, payload).unwrap();
        let new_id = receipt["setupId"]
            .as_str()
            .expect("reinserted setup id")
            .to_string();

        // Old row must be gone
        let old_rows = db
            .execute(
                "SELECT id FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "all",
            )
            .unwrap();
        assert!(old_rows.is_empty(), "old setup should be deleted");

        // New row must exist with correct coords
        let new_rows = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(new_id)],
                "get",
            )
            .unwrap();
        let row = new_rows.first().unwrap();
        assert_eq!(row["from_pos"], Value::Number(10.into()));
        assert_eq!(row["to_pos"], Value::Number(20.into()));
        assert_eq!(row["is_orphan"], Value::Number(0.into()));
    }

    #[test]
    fn resolve_orphan_reinsert_missing_setup_returns_none() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = OrphanResolvePayload {
            context: RendererWriteContext::default(),
            project_id,
            setup_id: "nonexistent".to_string(),
            base_version: 0,
            action: "reinsert".to_string(),
            scene_id: Some("sc".to_string()),
            from_pos: Some(1),
            to_pos: Some(5),
        };
        let result = resolve_orphan(&db, payload).unwrap();
        assert!(result["setupId"].is_null());
        assert!(result["foreshadow"].is_null());
    }

    #[test]
    fn resolve_orphan_reinsert_rejects_cross_project_scene_without_deleting_original() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let original_scene_id = insert_scene(&db, &project_id);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let setup_id = insert_setup(&db, &foreshadow_id, &original_scene_id, 1, 5, true);

        let error = resolve_orphan(
            &db,
            OrphanResolvePayload {
                context: RendererWriteContext::default(),
                project_id: project_id.clone(),
                setup_id: setup_id.clone(),
                base_version: 0,
                action: "reinsert".to_string(),
                scene_id: Some(foreign_scene_id),
                from_pos: Some(10),
                to_pos: Some(20),
            },
        )
        .expect_err("cross-project reinsert must be rejected");
        assert!(error.to_string().contains("same project"));

        let rows = db
            .execute(
                "SELECT foreshadow_id, scene_id, from_pos, to_pos, is_orphan
                   FROM foreshadow_setups WHERE id = ?",
                &[Value::String(setup_id)],
                "get",
            )
            .expect("original setup must survive rejected reinsert");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["foreshadow_id"], Value::String(foreshadow_id));
        assert_eq!(rows[0]["scene_id"], Value::String(original_scene_id));
        assert_eq!(rows[0]["from_pos"], Value::Number(1.into()));
        assert_eq!(rows[0]["to_pos"], Value::Number(5.into()));
        assert_eq!(rows[0]["is_orphan"], Value::Number(1.into()));
    }

    // ── save_anchors_for_scene ────────────────────────────────────────

    #[test]
    fn save_anchors_orphans_absent_setups() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let kept = insert_setup(&db, &fid, &scene, 1, 5, false);
        let gone = insert_setup(&db, &fid, &scene, 6, 10, false);

        // Only "kept" is in the setups list
        let setups = vec![SetupAnchorInput {
            id: kept.clone(),
            foreshadow_id: fid.clone(),
            base_version: 0,
            scene_id: scene.clone(),
            from_pos: 1,
            to_pos: 5,
        }];
        save_test_anchors(
            &db,
            proj.clone(),
            scene.clone(),
            setups,
            vec![],
            base_versions(&[(&fid, 0)]),
            50,
        )
        .unwrap();

        let rows = db
            .execute(
                "SELECT id, is_orphan FROM foreshadow_setups WHERE scene_id = ? ORDER BY id",
                &[Value::String(scene)],
                "all",
            )
            .unwrap();
        let orphan_map: std::collections::HashMap<String, i64> = rows
            .iter()
            .map(|r| {
                (
                    r["id"].as_str().unwrap().to_string(),
                    r["is_orphan"].as_i64().unwrap_or(0),
                )
            })
            .collect();
        assert_eq!(orphan_map[&kept], 0, "kept setup must not be orphaned");
        assert_eq!(orphan_map[&gone], 1, "gone setup must be orphaned");
    }

    #[test]
    fn save_anchors_payoff_advances_root_once_and_identical_repeat_is_noop() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        save_test_anchors(
            &db,
            project_id.clone(),
            scene_id.clone(),
            vec![],
            vec![PayoffAnchorInput {
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                scene_id: scene_id.clone(),
                from_pos: 4,
                to_pos: 12,
            }],
            base_versions(&[(&foreshadow_id, 0)]),
            50,
        )
        .expect("save payoff");
        save_test_anchors(
            &db,
            project_id.clone(),
            scene_id.clone(),
            vec![],
            vec![PayoffAnchorInput {
                foreshadow_id: foreshadow_id.clone(),
                base_version: 1,
                scene_id,
                from_pos: 4,
                to_pos: 12,
            }],
            base_versions(&[(&foreshadow_id, 1)]),
            50,
        )
        .expect("repeat payoff mutation");

        let rows = db
            .execute(
                "SELECT payoff_from_pos, payoff_to_pos, version
                 FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load payoff root");
        assert_eq!(rows[0]["payoff_from_pos"], Value::Number(4.into()));
        assert_eq!(rows[0]["payoff_to_pos"], Value::Number(12.into()));
        assert_eq!(rows[0]["version"], Value::Number(1.into()));
    }

    #[test]
    fn save_anchors_groups_multiple_setup_and_payoff_changes_into_one_root_bump() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        let first_setup = insert_setup(&db, &foreshadow_id, &scene_id, 1, 3, false);
        let second_setup = insert_setup(&db, &foreshadow_id, &scene_id, 4, 6, false);

        let rows = save_test_anchors(
            &db,
            project_id.clone(),
            scene_id.clone(),
            vec![
                SetupAnchorInput {
                    id: first_setup.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos: 2,
                    to_pos: 4,
                },
                SetupAnchorInput {
                    id: second_setup.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos: 5,
                    to_pos: 7,
                },
            ],
            vec![PayoffAnchorInput {
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                scene_id: scene_id.clone(),
                from_pos: 8,
                to_pos: 12,
            }],
            base_versions(&[(&foreshadow_id, 0)]),
            20,
        )
        .expect("persist grouped anchors");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["version"], 1);
        assert_eq!(foreshadow_version(&db, &foreshadow_id), 1);

        let unchanged = save_test_anchors(
            &db,
            project_id.clone(),
            scene_id.clone(),
            vec![
                SetupAnchorInput {
                    id: first_setup,
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 1,
                    scene_id: scene_id.clone(),
                    from_pos: 2,
                    to_pos: 4,
                },
                SetupAnchorInput {
                    id: second_setup,
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 1,
                    scene_id: scene_id.clone(),
                    from_pos: 5,
                    to_pos: 7,
                },
            ],
            vec![PayoffAnchorInput {
                foreshadow_id: foreshadow_id.clone(),
                base_version: 1,
                scene_id,
                from_pos: 8,
                to_pos: 12,
            }],
            base_versions(&[(&foreshadow_id, 1)]),
            20,
        )
        .expect("repeat identical grouped anchors");
        assert_eq!(unchanged.len(), 1);
        assert_eq!(unchanged[0]["version"], 1);
        assert_eq!(foreshadow_version(&db, &foreshadow_id), 1);
    }

    #[test]
    fn save_anchors_payoff_scene_mismatch_rejects_before_root_version_advance() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let first_id = insert_foreshadow(&db, &project_id);
        let second_id = insert_foreshadow(&db, &project_id);
        let local_scene_id = insert_scene(&db, &project_id);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);

        let error = save_test_anchors(
            &db,
            project_id.clone(),
            local_scene_id.clone(),
            vec![],
            vec![
                PayoffAnchorInput {
                    foreshadow_id: first_id.clone(),
                    base_version: 0,
                    scene_id: local_scene_id,
                    from_pos: 1,
                    to_pos: 5,
                },
                PayoffAnchorInput {
                    foreshadow_id: second_id.clone(),
                    base_version: 0,
                    scene_id: foreign_scene_id,
                    from_pos: 6,
                    to_pos: 10,
                },
            ],
            base_versions(&[(&first_id, 0), (&second_id, 0)]),
            50,
        )
        .expect_err("payoff scene mismatch must reject the full batch");
        assert!(error.to_string().contains("match the saved scene"));

        let rows = db
            .execute(
                "SELECT id, payoff_scene_id, version FROM foreshadows
                 WHERE id IN (?, ?) ORDER BY id",
                &[Value::String(first_id), Value::String(second_id)],
                "all",
            )
            .expect("load roots after rollback");
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row["payoff_scene_id"].is_null()));
        assert!(rows
            .iter()
            .all(|row| row["version"] == Value::Number(0.into())));
    }

    #[test]
    fn save_anchors_invalid_ranges_reject_before_any_setup_or_payoff_mutation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        let setup_id = insert_setup(&db, &foreshadow_id, &scene_id, 1, 5, false);

        for (from_pos, to_pos) in [(-1, 3), (6, 5), (0, 21)] {
            let error = save_test_anchors(
                &db,
                project_id.clone(),
                scene_id.clone(),
                vec![SetupAnchorInput {
                    id: setup_id.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos,
                    to_pos,
                }],
                vec![],
                base_versions(&[(&foreshadow_id, 0)]),
                20,
            )
            .expect_err("invalid setup range must be rejected");
            assert!(error.to_string().contains("setup range"));
        }

        for (from_pos, to_pos) in [(-1, 3), (6, 5), (0, 21)] {
            let error = save_test_anchors(
                &db,
                project_id.clone(),
                scene_id.clone(),
                vec![SetupAnchorInput {
                    id: setup_id.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos: 2,
                    to_pos: 4,
                }],
                vec![PayoffAnchorInput {
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: scene_id.clone(),
                    from_pos,
                    to_pos,
                }],
                base_versions(&[(&foreshadow_id, 0)]),
                20,
            )
            .expect_err("invalid payoff range must be rejected");
            assert!(error.to_string().contains("payoff range"));
        }

        let setup = db
            .execute(
                "SELECT from_pos, to_pos, is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(setup_id)],
                "get",
            )
            .expect("load unchanged setup");
        assert_eq!(setup[0]["from_pos"], Value::Number(1.into()));
        assert_eq!(setup[0]["to_pos"], Value::Number(5.into()));
        assert_eq!(setup[0]["is_orphan"], Value::Number(0.into()));

        let root = db
            .execute(
                "SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
                 FROM foreshadows WHERE id = ?",
                &[Value::String(foreshadow_id)],
                "get",
            )
            .expect("load unchanged payoff root");
        assert!(root[0]["payoff_scene_id"].is_null());
        assert!(root[0]["payoff_from_pos"].is_null());
        assert!(root[0]["payoff_to_pos"].is_null());
        assert_eq!(root[0]["version"], Value::Number(0.into()));
    }

    #[test]
    fn save_anchors_rejects_foreshadow_rebinding_and_scene_mismatch() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let other_foreshadow_id = insert_foreshadow(&db, &project_id);
        let original_scene_id = insert_scene(&db, &project_id);
        let destination_scene_id = insert_scene(&db, &project_id);
        let setup_id = insert_setup(&db, &foreshadow_id, &original_scene_id, 1, 5, false);

        let error = save_test_anchors(
            &db,
            project_id.clone(),
            original_scene_id.clone(),
            vec![SetupAnchorInput {
                id: setup_id.clone(),
                foreshadow_id: other_foreshadow_id.clone(),
                base_version: 0,
                scene_id: original_scene_id.clone(),
                from_pos: 10,
                to_pos: 20,
            }],
            vec![],
            base_versions(&[(&other_foreshadow_id, 0)]),
            50,
        )
        .expect_err("existing setup id must not be rebound to another foreshadow");
        assert!(error.to_string().contains("different foreshadow"));

        let mismatch = save_test_anchors(
            &db,
            project_id.clone(),
            original_scene_id.clone(),
            vec![SetupAnchorInput {
                id: setup_id.clone(),
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                scene_id: destination_scene_id.clone(),
                from_pos: 10,
                to_pos: 20,
            }],
            vec![],
            base_versions(&[(&foreshadow_id, 0)]),
            50,
        )
        .expect_err("anchor scene must match the top-level saved scene");
        assert!(mismatch.to_string().contains("match the saved scene"));

        let rows = db
            .execute(
                "SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
                   FROM foreshadow_setups WHERE id = ?",
                &[Value::String(setup_id)],
                "get",
            )
            .expect("load moved setup");
        assert_eq!(
            rows[0]["foreshadow_id"],
            Value::String(foreshadow_id.clone())
        );
        assert_eq!(
            rows[0]["scene_id"],
            Value::String(original_scene_id.clone())
        );
        assert_eq!(rows[0]["from_pos"], Value::Number(1.into()));
        assert_eq!(rows[0]["to_pos"], Value::Number(5.into()));
        assert_eq!(
            rows[0]["semantic_key"],
            Value::String(setup_semantic_key(&foreshadow_id, &original_scene_id, 1, 5,))
        );
    }

    #[test]
    fn save_anchors_scene_mismatch_rejects_before_earlier_updates() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let source_scene_id = insert_scene(&db, &project_id);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let first_id = insert_setup(&db, &foreshadow_id, &source_scene_id, 1, 5, false);
        let second_id = insert_setup(&db, &foreshadow_id, &source_scene_id, 6, 10, false);

        let error = save_test_anchors(
            &db,
            project_id.clone(),
            source_scene_id.clone(),
            vec![
                SetupAnchorInput {
                    id: first_id.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: source_scene_id.clone(),
                    from_pos: 11,
                    to_pos: 15,
                },
                SetupAnchorInput {
                    id: second_id.clone(),
                    foreshadow_id: foreshadow_id.clone(),
                    base_version: 0,
                    scene_id: foreign_scene_id,
                    from_pos: 16,
                    to_pos: 20,
                },
            ],
            vec![],
            base_versions(&[(&foreshadow_id, 0)]),
            50,
        )
        .expect_err("scene mismatch must reject the whole anchor batch");
        assert!(error.to_string().contains("match the saved scene"));

        let rows = db
            .execute(
                "SELECT id, scene_id, from_pos, to_pos
                   FROM foreshadow_setups WHERE id IN (?, ?) ORDER BY from_pos",
                &[
                    Value::String(first_id.clone()),
                    Value::String(second_id.clone()),
                ],
                "all",
            )
            .expect("load setups after rejected batch");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["id"], Value::String(first_id));
        assert_eq!(rows[0]["scene_id"], Value::String(source_scene_id.clone()));
        assert_eq!(rows[0]["from_pos"], Value::Number(1.into()));
        assert_eq!(rows[1]["id"], Value::String(second_id));
        assert_eq!(rows[1]["scene_id"], Value::String(source_scene_id));
        assert_eq!(rows[1]["from_pos"], Value::Number(6.into()));
    }

    #[test]
    fn save_anchors_preserves_matching_legacy_duplicate_semantic_key() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let scene_id = insert_scene(&db, &project_id);
        insert_setup(&db, &foreshadow_id, &scene_id, 1, 5, false);
        let duplicate_id = "legacy-save-anchor-duplicate".to_string();
        let natural_key = setup_semantic_key(&foreshadow_id, &scene_id, 1, 5);
        let legacy_key = format!("{natural_key}#dup:{duplicate_id}");
        insert_setup_with_semantic_key(
            &db,
            duplicate_id.clone(),
            &foreshadow_id,
            &scene_id,
            1,
            5,
            false,
            legacy_key.clone(),
        );

        save_test_anchors(
            &db,
            project_id.clone(),
            scene_id.clone(),
            vec![SetupAnchorInput {
                id: duplicate_id.clone(),
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                scene_id,
                from_pos: 1,
                to_pos: 5,
            }],
            vec![],
            base_versions(&[(&foreshadow_id, 0)]),
            50,
        )
        .expect("legacy duplicate should not collide with its unsuffixed peer");

        let rows = db
            .execute(
                "SELECT semantic_key FROM foreshadow_setups WHERE id = ?",
                &[Value::String(duplicate_id)],
                "get",
            )
            .expect("load preserved legacy key");
        assert_eq!(rows[0]["semantic_key"], Value::String(legacy_key));
    }

    #[test]
    fn save_anchors_bulk_orphan_skipped_when_doc_has_content() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 1, 5, false);

        // setups empty but doc has content (size > 2) → bulk orphan must be skipped
        save_test_anchors(
            &db,
            proj.clone(),
            scene.clone(),
            vec![],
            vec![],
            base_versions(&[]),
            50,
        )
        .unwrap();

        let rows = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        assert_eq!(
            rows.first().unwrap()["is_orphan"],
            Value::Number(0.into()),
            "must not bulk-orphan when doc has content"
        );
    }

    #[test]
    fn save_anchors_bulk_orphan_fires_when_doc_empty() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 1, 5, false);

        // setups empty and doc is empty (size <= 2) → bulk orphan must fire
        save_test_anchors(
            &db,
            proj.clone(),
            scene.clone(),
            vec![],
            vec![],
            base_versions(&[(&fid, 0)]),
            2,
        )
        .unwrap();

        let rows = db
            .execute(
                "SELECT is_orphan FROM foreshadow_setups WHERE id = ?",
                &[Value::String(sid)],
                "get",
            )
            .unwrap();
        assert_eq!(
            rows.first().unwrap()["is_orphan"],
            Value::Number(1.into()),
            "must bulk-orphan when doc is empty"
        );
    }

    // ── load_anchors_for_scene ────────────────────────────────────────

    #[test]
    fn load_anchors_skips_setup_with_zero_coords() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        // Insert setup with from=0/to=0 (invalid coords)
        insert_setup(&db, &fid, &scene, 0, 0, false);

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert!(
            result.is_empty(),
            "setup with zero coords must be filtered out"
        );
    }

    #[test]
    fn load_anchors_returns_valid_setup() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        insert_setup(&db, &fid, &scene, 10, 20, false);

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].from, 10);
        assert_eq!(result[0].to, 20);
        assert_eq!(result[0].mark_name, "foreshadowSetup");
    }

    #[test]
    fn load_anchors_skips_orphan_setups() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        insert_setup(&db, &fid, &scene, 10, 20, true); // orphan

        let result = load_anchors_for_scene(&db, scene.clone()).unwrap();
        assert!(result.is_empty(), "orphan setup must be excluded");
    }
}
