//! Plot thread (Plottr 型プロットスレッド) の DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/plot_threads.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `foreshadow` と同じ構図)。署名・SQL・
//! XPROJ ガード・エラー文字列は移動前と完全に同一。
//!
//! `plot_threads` = タイムライン上の名前付き横レーン、
//! `plot_thread_scene_links` = スレッドが特定シーンで踏む段階マーカー。
//! schema は src-tauri/src/database/migrate.rs と src/db/schema.ts でミラー。

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::{
    idempotency::{
        insert_idempotent_response, load_idempotent_response, load_row, payload_fingerprint,
        run_atomic_create, IdempotencyRequest,
    },
    Database,
};
use crate::change_events::AppendChangeEvent;
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_object_key, narrative_snapshot_digest,
    require_typed_inverse_lineage_in_project, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];
const BRANCH_KINDS: [&str; 2] = ["branch", "merge"];

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererWriteContext {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
}

#[cfg(test)]
impl Default for RendererWriteContext {
    fn default() -> Self {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            request_id: format!("plot-test-request-{id}"),
            session_id: "plot-test-session".to_string(),
            event_uid: format!("plot-test-event-{id}"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
        }
    }
}

#[derive(Clone, Debug)]
struct ResolvedWriteContext {
    request_id: String,
    session_id: String,
    event_uid: String,
    cause_kind: NarrativeChangeCauseKind,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<String>,
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
    })
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

fn run_atomic_plot_mutation<Mutate>(
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

fn row_version(value: Option<&Value>) -> Option<i64> {
    value
        .and_then(Value::as_object)
        .and_then(|row| row.get("version"))
        .and_then(Value::as_i64)
}

fn state_digest(value: Option<&Value>) -> anyhow::Result<Option<String>> {
    value.map(narrative_snapshot_digest).transpose()
}

fn plot_feed_event(
    object_key: Value,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    mut changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    changed_paths.sort();
    changed_paths.dedup();
    Ok(NarrativeChangeEventInput {
        object_key,
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: row_version(before),
        before_digest: state_digest(before)?,
        after_version: row_version(after),
        after_digest: state_digest(after)?,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
        changed_paths,
        text_impact: None,
    })
}

fn plot_root_feed_event(
    thread_id: &str,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    plot_feed_event(
        json!({ "kind": "plot-thread", "threadId": thread_id }),
        change_kind,
        mutation_kind,
        before,
        after,
        changed_paths,
    )
}

fn plot_marker_feed_event(
    marker_id: &str,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    plot_feed_event(
        narrative_object_key("plot_thread_marker", marker_id),
        change_kind,
        mutation_kind,
        before,
        after,
        changed_paths,
    )
}

fn plot_branch_feed_event(
    branch_id: &str,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    plot_feed_event(
        narrative_object_key("plot_thread_branch", branch_id),
        change_kind,
        mutation_kind,
        before,
        after,
        changed_paths,
    )
}

struct PlotFeedAppend<'a> {
    project_id: &'a str,
    operation: &'a str,
    entity_type: &'a str,
    entity_id: &'a str,
    context: &'a ResolvedWriteContext,
    cause_kind: NarrativeChangeCauseKind,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<String>,
    events: Vec<NarrativeChangeEventInput>,
}

fn append_plot_feed(conn: &Connection, input: PlotFeedAppend<'_>) -> anyhow::Result<String> {
    if let Some(original_transaction_id) = input.original_transaction_id.as_deref() {
        require_typed_inverse_lineage_in_project(
            conn,
            input.project_id,
            original_transaction_id,
            "plot",
            input.entity_id,
        )?;
    }
    let timestamp = chrono::Utc::now().timestamp_millis();
    let occurred_at = chrono::DateTime::from_timestamp_millis(timestamp)
        .ok_or_else(|| anyhow::anyhow!("plot writer timestamp is outside the supported range"))?
        .to_rfc3339();
    let mut events = input.events;
    normalize_plot_feed_events_in_tx(conn, input.project_id, &mut events)?;
    let canonical = AppendChangeEvent {
        event_uid: input.context.event_uid.clone(),
        scene_id: None,
        domain: "plot".to_string(),
        op_type: input.operation.to_string(),
        entity_type: Some(input.entity_type.to_string()),
        entity_id: Some(input.entity_id.to_string()),
        payload: serde_json::to_string(&json!({
            "requestId": input.context.request_id,
            "origin": input.origin,
        }))?,
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
            cause_kind: input.cause_kind,
            origin: input.origin,
            original_transaction_id: input.original_transaction_id,
            commit_id: None,
            journal_id: None,
            undo_journal_id: None,
            application_ids: Vec::new(),
            occurred_at,
            events,
        },
    )?;
    Ok(result.narrative.transaction_id)
}

fn normalize_plot_feed_events_in_tx(
    conn: &Connection,
    project_id: &str,
    events: &mut [NarrativeChangeEventInput],
) -> anyhow::Result<()> {
    // Plot marker/branch writers historically used their direct `SELECT *`
    // rows for Feed digests.  The canonical loader is the single shape used
    // by replay/freshness consumers, so normalize at the shared append edge
    // and source update/delete `before` state from the existing Feed head.
    for event in events {
        let kind = event.object_key.get("kind").and_then(Value::as_str);
        if !matches!(
            kind,
            Some("plot-thread") | Some("plot-marker") | Some("plot-branch") | Some("component")
        ) {
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

fn validate_phase(p: &str) -> anyhow::Result<()> {
    if PHASE_TYPES.contains(&p) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid phase_type: {p:?}"))
    }
}

fn validate_branch_kind(kind: &str) -> anyhow::Result<()> {
    if BRANCH_KINDS.contains(&kind) {
        Ok(())
    } else {
        Err(anyhow::anyhow!("invalid plot branch kind: {kind:?}"))
    }
}

fn one(rows: Vec<serde_json::Map<String, Value>>) -> Value {
    rows.first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null)
}

/// Preserve the distinction required by PATCH payloads:
///
/// - an omitted field leaves the outer `Option` as `None`;
/// - an explicit JSON `null` becomes `Some(None)`;
/// - a concrete value becomes `Some(Some(value))`.
///
/// Serde's built-in `Option<Option<T>>` handling otherwise maps both omission
/// and `null` to the outer `None`, which turns an Electron clear into a no-op.
fn deserialize_present_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

fn delete_versioned_row(
    db: &Database,
    table: &str,
    conflict_marker: &str,
    payload: PlotDeletePayload,
) -> anyhow::Result<Value> {
    let (operation, entity_type, idempotency_domain, idempotency_conflict) = match table {
        "plot_threads" => (
            "plot.thread.delete",
            "plot-thread",
            "plot_thread_delete",
            "PLOT_THREAD_DELETE_IDEMPOTENCY_CONFLICT",
        ),
        "plot_thread_scene_links" => (
            "plot.marker.delete",
            "plot-marker",
            "plot_thread_link_delete",
            "PLOT_THREAD_LINK_DELETE_IDEMPOTENCY_CONFLICT",
        ),
        "plot_thread_branches" => (
            "plot.branch.delete",
            "plot-branch",
            "plot_thread_branch_delete",
            "PLOT_THREAD_BRANCH_DELETE_IDEMPOTENCY_CONFLICT",
        ),
        _ => anyhow::bail!("unsupported plot delete table: {table}"),
    };
    let write_context = resolve_write_context(operation, &payload.context)?;
    let payload_hash = payload_fingerprint(
        idempotency_domain,
        &json!({
            "id": payload.id,
            "projectId": payload.project_id,
            "baseVersion": payload.base_version,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
        }),
    )?;
    let id = payload.id;
    let project_id = payload.project_id;
    let base_version = payload.base_version;
    let request = IdempotencyRequest {
        domain: idempotency_domain,
        request_id: Some(write_context.request_id.as_str()),
        payload_hash: &payload_hash,
        conflict_marker: idempotency_conflict,
    };
    run_atomic_plot_mutation(db, request, &project_id, |conn| {
        let actual_project_id = project_for_plot_table(conn, table, &id)?
            .ok_or_else(|| anyhow::anyhow!("{table} row not found: {id}"))?;
        anyhow::ensure!(
            actual_project_id == project_id,
            "plot delete target belongs to another project"
        );
        let before = load_row(conn, table, &id)?
            .ok_or_else(|| anyhow::anyhow!("{table} row not found: {id}"))?;
        let delete_sql = format!("DELETE FROM {table} WHERE id = ? AND version = ?");
        Database::execute_with_conn(
            conn,
            &delete_sql,
            &[
                Value::String(id.clone()),
                Value::Number(base_version.into()),
            ],
            "run",
        )?;
        if conn.changes() == 1 {
            let (entity_kind, field_paths) = plot_entity_authority(table);
            record_plot_field_authority(conn, &project_id, entity_kind, &id, field_paths)?;
            let event = match table {
                "plot_threads" => plot_root_feed_event(
                    &id,
                    "catalog",
                    "delete",
                    Some(&before),
                    None,
                    vec!["/".to_string()],
                )?,
                "plot_thread_scene_links" => plot_marker_feed_event(
                    &id,
                    "association",
                    "delete",
                    Some(&before),
                    None,
                    vec!["/".to_string()],
                )?,
                "plot_thread_branches" => plot_branch_feed_event(
                    &id,
                    "association",
                    "delete",
                    Some(&before),
                    None,
                    vec!["/".to_string()],
                )?,
                _ => unreachable!("delete table was validated above"),
            };
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &project_id,
                    operation,
                    entity_type,
                    entity_id: &id,
                    context: &write_context,
                    cause_kind: write_context.cause_kind,
                    origin: write_context.origin,
                    original_transaction_id: write_context.original_transaction_id.clone(),
                    events: vec![event],
                },
            )?;
            return Ok(json!({
                "id": id,
                "deleted": true,
                "maintenanceTransactionId": transaction_id,
            }));
        }
        let select_sql = format!("SELECT version FROM {table} WHERE id = ?");
        let rows =
            Database::execute_with_conn(conn, &select_sql, &[Value::String(id.clone())], "get")?;
        let current = rows
            .first()
            .ok_or_else(|| anyhow::anyhow!("{table} row not found: {id}"))?;
        let current_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
        anyhow::bail!("{conflict_marker}: expected {base_version}, found {current_version}")
    })
}

/// 行 id の所属 project_id を引く。table は静的リテラルのみ（インジェクション無し）。
fn project_of_conn(conn: &Connection, table: &str, id: &str) -> anyhow::Result<Option<String>> {
    let sql = format!("SELECT project_id FROM {table} WHERE id = ?");
    let rows = Database::execute_with_conn(conn, &sql, &[Value::String(id.to_string())], "get")?;
    Ok(rows
        .first()
        .and_then(|r| r.get("project_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

fn project_for_plot_table(
    conn: &Connection,
    table: &str,
    id: &str,
) -> anyhow::Result<Option<String>> {
    if table == "plot_thread_scene_links" {
        return Ok(conn
            .query_row(
                "SELECT t.project_id
                   FROM plot_thread_scene_links l
                   INNER JOIN plot_threads t ON t.id = l.thread_id
                  WHERE l.id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?);
    }
    project_of_conn(conn, table, id)
}

fn record_plot_field_authority(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    field_paths: &[&str],
) -> anyhow::Result<()> {
    crate::narrative_extraction::record_human_field_write(
        conn,
        project_id,
        entity_kind,
        entity_id,
        field_paths,
        &chrono::Utc::now().to_rfc3339(),
    )
}

fn plot_entity_authority(table: &str) -> (&'static str, &'static [&'static str]) {
    match table {
        "plot_threads" => (
            "plot-thread",
            &[
                "/name",
                "/description",
                "/color",
                "/sortOrder",
                "/startNodeId",
                "/endNodeId",
            ],
        ),
        "plot_thread_scene_links" => (
            "plot-marker",
            &[
                "/threadId",
                "/sceneId",
                "/phaseType",
                "/note",
                "/sortOrder",
                "/semanticKey",
            ],
        ),
        "plot_thread_branches" => (
            "plot-branch",
            &[
                "/fromThreadId",
                "/toThreadId",
                "/atSceneId",
                "/kind",
                "/semanticKey",
            ],
        ),
        _ => panic!("plot authority requested for unsupported table '{table}'"),
    }
}

// ─────────────────────── DTO ───────────────────────

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadCreatePayload {
    /// Domain-owned idempotency key. Renderer retries reuse this ID so a lost
    /// response cannot create a second logical thread.
    #[serde(default)]
    id: Option<String>,
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    name: String,
    color: Option<String>,
    description: Option<String>,
    sort_order: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadPatch {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    description: Option<Option<String>>,
    sort_order: Option<String>,
    base_version: i64,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkCreatePayload {
    /// Domain-owned idempotency key for renderer retries.
    #[serde(default)]
    id: Option<String>,
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    thread_id: String,
    node_id: String,
    phase_type: String,
    note: Option<String>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkPatch {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    thread_id: Option<String>,
    node_id: Option<String>,
    phase_type: Option<String>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    note: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_present_nullable")]
    sort_order: Option<Option<String>>,
    base_version: i64,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadBranchCreatePayload {
    /// Domain-owned idempotency key for renderer retries.
    #[serde(default)]
    id: Option<String>,
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    from_thread_id: String,
    to_thread_id: String,
    at_node_id: String,
    kind: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadBranchPatch {
    #[serde(flatten)]
    context: RendererWriteContext,
    project_id: String,
    from_thread_id: Option<String>,
    to_thread_id: Option<String>,
    at_node_id: Option<String>,
    base_version: i64,
}

/// Full persisted row used by history restore. Timestamps are intentionally
/// retained: undo/redo restores identity and ordering metadata, not a new
/// logical entity.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadSnapshotRow {
    id: String,
    project_id: String,
    name: String,
    color: Option<String>,
    description: Option<String>,
    sort_order: String,
    start_node_id: Option<String>,
    end_node_id: Option<String>,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    version: i64,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkSnapshotRow {
    id: String,
    thread_id: String,
    node_id: String,
    phase_type: String,
    note: Option<String>,
    sort_order: Option<String>,
    #[serde(default)]
    semantic_key: Option<String>,
    #[serde(default)]
    version: i64,
    created_at: String,
    updated_at: String,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadBranchSnapshotRow {
    id: String,
    project_id: String,
    from_thread_id: String,
    to_thread_id: String,
    at_node_id: String,
    kind: String,
    #[serde(default)]
    semantic_key: Option<String>,
    #[serde(default)]
    version: i64,
    created_at: String,
    updated_at: String,
}

/// One history operation can restore a parent thread and every child removed
/// by CASCADE, or a marker and its dependent branches. All rows and the durable
/// request ledger are committed in one transaction.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadRestoreSnapshotPayload {
    request_id: String,
    session_id: String,
    event_uid: String,
    origin: NarrativeChangeOrigin,
    #[serde(default)]
    original_transaction_id: Option<String>,
    project_id: String,
    #[serde(default)]
    thread: Option<PlotThreadSnapshotRow>,
    #[serde(default)]
    links: Vec<PlotThreadLinkSnapshotRow>,
    #[serde(default)]
    branches: Vec<PlotThreadBranchSnapshotRow>,
}

/// Exact history deletion for either a whole thread aggregate or one marker
/// plus its semantically dependent branches. Exactly one of `thread` and
/// `link` must be present.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadDeleteSnapshotPayload {
    request_id: String,
    session_id: String,
    event_uid: String,
    origin: NarrativeChangeOrigin,
    #[serde(default)]
    original_transaction_id: Option<String>,
    project_id: String,
    #[serde(default)]
    thread: Option<PlotThreadSnapshotRow>,
    #[serde(default)]
    link: Option<PlotThreadLinkSnapshotRow>,
    #[serde(default)]
    links: Vec<PlotThreadLinkSnapshotRow>,
    #[serde(default)]
    branches: Vec<PlotThreadBranchSnapshotRow>,
}

/// One before/after branch transition in a marker drag. `None -> Some` creates,
/// `Some -> Some` updates, and `Some -> None` deletes the full persisted row.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadBranchTransition {
    #[serde(default)]
    before: Option<PlotThreadBranchSnapshotRow>,
    #[serde(default)]
    after: Option<PlotThreadBranchSnapshotRow>,
}

/// Marker movement and every dependent branch transition are one durable,
/// idempotent transaction. Full rows act as OCC preconditions for both the
/// initial command and history replay.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadMoveMarkerBundlePayload {
    request_id: String,
    session_id: String,
    event_uid: String,
    origin: NarrativeChangeOrigin,
    #[serde(default)]
    original_transaction_id: Option<String>,
    project_id: String,
    marker_before: PlotThreadLinkSnapshotRow,
    marker_after: PlotThreadLinkSnapshotRow,
    #[serde(default)]
    branch_transitions: Vec<PlotThreadBranchTransition>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotDeletePayload {
    id: String,
    project_id: String,
    base_version: i64,
    #[serde(flatten)]
    context: RendererWriteContext,
}

fn load_map(
    conn: &Connection,
    table: &str,
    id: &str,
) -> anyhow::Result<Option<Map<String, Value>>> {
    Ok(load_row(conn, table, id)?.and_then(|value| value.as_object().cloned()))
}

fn nullable_string_value(value: &Option<String>) -> Value {
    value.clone().map(Value::String).unwrap_or(Value::Null)
}

fn link_natural_key(row: &PlotThreadLinkSnapshotRow) -> String {
    format!("{}|{}|{}", row.thread_id, row.node_id, row.phase_type)
}

fn branch_natural_key(row: &PlotThreadBranchSnapshotRow) -> String {
    format!(
        "{}|{}|{}|{}",
        row.from_thread_id, row.to_thread_id, row.at_node_id, row.kind
    )
}

fn effective_semantic_key(explicit: &Option<String>, natural: String) -> String {
    explicit
        .as_deref()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(natural)
}

fn link_semantic_key(row: &PlotThreadLinkSnapshotRow) -> String {
    effective_semantic_key(&row.semantic_key, link_natural_key(row))
}

fn branch_semantic_key(row: &PlotThreadBranchSnapshotRow) -> String {
    effective_semantic_key(&row.semantic_key, branch_natural_key(row))
}

fn validate_snapshot_semantic_key(
    explicit: &Option<String>,
    natural: &str,
    label: &str,
) -> anyhow::Result<()> {
    let Some(explicit) = explicit.as_deref().filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let valid = explicit == natural
        || explicit
            .strip_prefix(natural)
            .is_some_and(|suffix| suffix.starts_with("#dup:") && suffix.len() > 5);
    anyhow::ensure!(valid, "{label} semanticKey does not match its topology");
    Ok(())
}

fn row_string<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

fn thread_row_matches(row: &Map<String, Value>, expected: &PlotThreadSnapshotRow) -> bool {
    row_string(row, "id") == Some(expected.id.as_str())
        && row_string(row, "project_id") == Some(expected.project_id.as_str())
        && row_string(row, "name") == Some(expected.name.as_str())
        && row.get("color") == Some(&nullable_string_value(&expected.color))
        && row.get("description") == Some(&nullable_string_value(&expected.description))
        && row_string(row, "sort_order") == Some(expected.sort_order.as_str())
        && row.get("start_node_id") == Some(&nullable_string_value(&expected.start_node_id))
        && row.get("end_node_id") == Some(&nullable_string_value(&expected.end_node_id))
        && row_string(row, "created_at") == Some(expected.created_at.as_str())
        && row_string(row, "updated_at") == Some(expected.updated_at.as_str())
        && row.get("version").and_then(Value::as_i64) == Some(expected.version)
}

fn link_row_matches(row: &Map<String, Value>, expected: &PlotThreadLinkSnapshotRow) -> bool {
    row_string(row, "id") == Some(expected.id.as_str())
        && row_string(row, "thread_id") == Some(expected.thread_id.as_str())
        && row_string(row, "node_id") == Some(expected.node_id.as_str())
        && row_string(row, "phase_type") == Some(expected.phase_type.as_str())
        && row.get("note") == Some(&nullable_string_value(&expected.note))
        && row.get("sort_order") == Some(&nullable_string_value(&expected.sort_order))
        && row_string(row, "semantic_key") == Some(link_semantic_key(expected).as_str())
        && row.get("version").and_then(Value::as_i64) == Some(expected.version)
        && row_string(row, "created_at") == Some(expected.created_at.as_str())
        && row_string(row, "updated_at") == Some(expected.updated_at.as_str())
}

fn branch_row_matches(row: &Map<String, Value>, expected: &PlotThreadBranchSnapshotRow) -> bool {
    row_string(row, "id") == Some(expected.id.as_str())
        && row_string(row, "project_id") == Some(expected.project_id.as_str())
        && row_string(row, "from_thread_id") == Some(expected.from_thread_id.as_str())
        && row_string(row, "to_thread_id") == Some(expected.to_thread_id.as_str())
        && row_string(row, "at_node_id") == Some(expected.at_node_id.as_str())
        && row_string(row, "kind") == Some(expected.kind.as_str())
        && row_string(row, "semantic_key") == Some(branch_semantic_key(expected).as_str())
        && row.get("version").and_then(Value::as_i64) == Some(expected.version)
        && row_string(row, "created_at") == Some(expected.created_at.as_str())
        && row_string(row, "updated_at") == Some(expected.updated_at.as_str())
}

fn require_project(conn: &Connection, project_id: &str) -> anyhow::Result<()> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT id FROM projects WHERE id = ?",
        &[Value::String(project_id.to_string())],
        "get",
    )?;
    if rows.is_empty() {
        anyhow::bail!("plot snapshot project does not exist");
    }
    Ok(())
}

fn require_project_member(
    conn: &Connection,
    table: &str,
    id: &str,
    project_id: &str,
    label: &str,
) -> anyhow::Result<()> {
    if project_of_conn(conn, table, id)?.as_deref() != Some(project_id) {
        anyhow::bail!("{label} must belong to the snapshot project");
    }
    Ok(())
}

fn require_project_scene(
    conn: &Connection,
    id: &str,
    project_id: &str,
    label: &str,
) -> anyhow::Result<()> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT id FROM tree_nodes
          WHERE id = ? AND project_id = ? AND node_type = 'scene'",
        &[
            Value::String(id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?;
    if rows.is_empty() {
        anyhow::bail!("{label} must be a scene in the snapshot project");
    }
    Ok(())
}

fn validate_restore_snapshot_shape(
    payload: &PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<()> {
    if payload.request_id.is_empty() {
        anyhow::bail!("plot restore snapshot requestId must be non-empty");
    }
    if payload.project_id.is_empty() {
        anyhow::bail!("plot restore snapshot projectId must be non-empty");
    }
    if payload.thread.is_none() && payload.links.is_empty() && payload.branches.is_empty() {
        anyhow::bail!("plot restore snapshot must contain at least one row");
    }
    if let Some(thread) = &payload.thread {
        anyhow::ensure!(
            thread.version >= 0,
            "plot restore thread version must be non-negative"
        );
        for (label, value) in [
            ("thread.id", thread.id.as_str()),
            ("thread.projectId", thread.project_id.as_str()),
            ("thread.name", thread.name.as_str()),
            ("thread.sortOrder", thread.sort_order.as_str()),
            ("thread.createdAt", thread.created_at.as_str()),
            ("thread.updatedAt", thread.updated_at.as_str()),
        ] {
            if value.is_empty() {
                anyhow::bail!("plot restore snapshot {label} must be non-empty");
            }
        }
        for (label, value) in [
            ("thread.startNodeId", thread.start_node_id.as_deref()),
            ("thread.endNodeId", thread.end_node_id.as_deref()),
        ] {
            if value == Some("") {
                anyhow::bail!("plot restore snapshot {label} must be non-empty when present");
            }
        }
    }
    let mut ids = HashSet::new();
    for link in &payload.links {
        anyhow::ensure!(
            link.version >= 0,
            "plot restore link version must be non-negative"
        );
        validate_snapshot_semantic_key(
            &link.semantic_key,
            &link_natural_key(link),
            "plot restore link",
        )?;
        for (label, value) in [
            ("link.id", link.id.as_str()),
            ("link.threadId", link.thread_id.as_str()),
            ("link.nodeId", link.node_id.as_str()),
            ("link.phaseType", link.phase_type.as_str()),
            ("link.createdAt", link.created_at.as_str()),
            ("link.updatedAt", link.updated_at.as_str()),
        ] {
            if value.is_empty() {
                anyhow::bail!("plot restore snapshot {label} must be non-empty");
            }
        }
        if !ids.insert(("link", link.id.as_str())) {
            anyhow::bail!("plot restore snapshot contains duplicate link ids");
        }
    }
    for branch in &payload.branches {
        anyhow::ensure!(
            branch.version >= 0,
            "plot restore branch version must be non-negative"
        );
        validate_snapshot_semantic_key(
            &branch.semantic_key,
            &branch_natural_key(branch),
            "plot restore branch",
        )?;
        for (label, value) in [
            ("branch.id", branch.id.as_str()),
            ("branch.projectId", branch.project_id.as_str()),
            ("branch.fromThreadId", branch.from_thread_id.as_str()),
            ("branch.toThreadId", branch.to_thread_id.as_str()),
            ("branch.atNodeId", branch.at_node_id.as_str()),
            ("branch.kind", branch.kind.as_str()),
            ("branch.createdAt", branch.created_at.as_str()),
            ("branch.updatedAt", branch.updated_at.as_str()),
        ] {
            if value.is_empty() {
                anyhow::bail!("plot restore snapshot {label} must be non-empty");
            }
        }
        if !ids.insert(("branch", branch.id.as_str())) {
            anyhow::bail!("plot restore snapshot contains duplicate branch ids");
        }
    }
    Ok(())
}

fn validate_restore_snapshot_membership(
    conn: &Connection,
    payload: &PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<()> {
    require_project(conn, &payload.project_id)?;
    if let Some(thread) = &payload.thread {
        if thread.project_id != payload.project_id {
            anyhow::bail!("plot restore thread must belong to the snapshot project");
        }
        for node_id in [&thread.start_node_id, &thread.end_node_id]
            .into_iter()
            .flatten()
        {
            require_project_scene(
                conn,
                node_id,
                &payload.project_id,
                "plot restore thread boundary scene",
            )?;
        }
    }
    for link in &payload.links {
        validate_phase(&link.phase_type)?;
        require_project_member(
            conn,
            "plot_threads",
            &link.thread_id,
            &payload.project_id,
            "plot restore link thread",
        )?;
        require_project_scene(
            conn,
            &link.node_id,
            &payload.project_id,
            "plot restore link scene",
        )?;
    }
    for branch in &payload.branches {
        validate_branch_kind(&branch.kind)?;
        if branch.project_id != payload.project_id {
            anyhow::bail!("plot restore branch must belong to the snapshot project");
        }
        if branch.from_thread_id == branch.to_thread_id {
            anyhow::bail!("plot thread branch cannot reference the same thread twice");
        }
        require_project_member(
            conn,
            "plot_threads",
            &branch.from_thread_id,
            &payload.project_id,
            "plot restore branch source thread",
        )?;
        require_project_member(
            conn,
            "plot_threads",
            &branch.to_thread_id,
            &payload.project_id,
            "plot restore branch target thread",
        )?;
        require_project_scene(
            conn,
            &branch.at_node_id,
            &payload.project_id,
            "plot restore branch scene",
        )?;
    }
    Ok(())
}

fn insert_or_validate_thread(conn: &Connection, row: &PlotThreadSnapshotRow) -> anyhow::Result<()> {
    if let Some(existing) = load_map(conn, "plot_threads", &row.id)? {
        if thread_row_matches(&existing, row) {
            return Ok(());
        }
        anyhow::bail!("PLOT_THREAD_RESTORE_CONFLICT: thread id already has different content");
    }
    Database::execute_with_conn(
        conn,
        "INSERT INTO plot_threads
             (id, project_id, name, color, description, sort_order,
              start_node_id, end_node_id, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(row.id.clone()),
            Value::String(row.project_id.clone()),
            Value::String(row.name.clone()),
            nullable_string_value(&row.color),
            nullable_string_value(&row.description),
            Value::String(row.sort_order.clone()),
            nullable_string_value(&row.start_node_id),
            nullable_string_value(&row.end_node_id),
            Value::String(row.created_at.clone()),
            Value::String(row.updated_at.clone()),
            Value::Number(row.version.into()),
        ],
        "run",
    )?;
    Ok(())
}

fn insert_or_validate_link(
    conn: &Connection,
    row: &PlotThreadLinkSnapshotRow,
) -> anyhow::Result<()> {
    if let Some(existing) = load_map(conn, "plot_thread_scene_links", &row.id)? {
        if link_row_matches(&existing, row) {
            return Ok(());
        }
        anyhow::bail!("PLOT_THREAD_RESTORE_CONFLICT: link id already has different content");
    }
    Database::execute_with_conn(
        conn,
        "INSERT INTO plot_thread_scene_links
             (id, thread_id, node_id, phase_type, note, sort_order,
              semantic_key, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(row.id.clone()),
            Value::String(row.thread_id.clone()),
            Value::String(row.node_id.clone()),
            Value::String(row.phase_type.clone()),
            nullable_string_value(&row.note),
            nullable_string_value(&row.sort_order),
            Value::String(link_semantic_key(row)),
            Value::Number(row.version.into()),
            Value::String(row.created_at.clone()),
            Value::String(row.updated_at.clone()),
        ],
        "run",
    )?;
    Ok(())
}

fn insert_or_validate_branch(
    conn: &Connection,
    row: &PlotThreadBranchSnapshotRow,
) -> anyhow::Result<()> {
    if let Some(existing) = load_map(conn, "plot_thread_branches", &row.id)? {
        if branch_row_matches(&existing, row) {
            return Ok(());
        }
        anyhow::bail!("PLOT_THREAD_RESTORE_CONFLICT: branch id already has different content");
    }
    Database::execute_with_conn(
        conn,
        "INSERT INTO plot_thread_branches
             (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
              semantic_key, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(row.id.clone()),
            Value::String(row.project_id.clone()),
            Value::String(row.from_thread_id.clone()),
            Value::String(row.to_thread_id.clone()),
            Value::String(row.at_node_id.clone()),
            Value::String(row.kind.clone()),
            Value::String(branch_semantic_key(row)),
            Value::Number(row.version.into()),
            Value::String(row.created_at.clone()),
            Value::String(row.updated_at.clone()),
        ],
        "run",
    )?;
    Ok(())
}

fn restore_snapshot_response(
    request_id: &str,
    payload: &PlotThreadRestoreSnapshotPayload,
) -> Value {
    json!({
        "id": request_id,
        "thread": payload.thread,
        "links": payload.links,
        "branches": payload.branches,
    })
}

fn advance_restore_snapshot_versions(
    payload: &mut PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<()> {
    if let Some(thread) = payload.thread.as_mut() {
        thread.version = thread
            .version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("plot thread restore version overflow"))?;
    }
    for link in &mut payload.links {
        link.version = link
            .version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("plot link restore version overflow"))?;
    }
    for branch in &mut payload.branches {
        branch.version = branch
            .version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("plot branch restore version overflow"))?;
    }
    Ok(())
}

fn load_exact_restore_snapshot(
    conn: &Connection,
    request_id: &str,
    payload: &PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<Option<Value>> {
    if let Some(expected) = &payload.thread {
        let Some(row) = load_map(conn, "plot_threads", &expected.id)? else {
            return Ok(None);
        };
        if !thread_row_matches(&row, expected) {
            return Ok(None);
        }
    }
    for expected in &payload.links {
        let Some(row) = load_map(conn, "plot_thread_scene_links", &expected.id)? else {
            return Ok(None);
        };
        if !link_row_matches(&row, expected) {
            return Ok(None);
        }
    }
    for expected in &payload.branches {
        let Some(row) = load_map(conn, "plot_thread_branches", &expected.id)? else {
            return Ok(None);
        };
        if !branch_row_matches(&row, expected) {
            return Ok(None);
        }
    }
    Ok(Some(restore_snapshot_response(request_id, payload)))
}

// ─────────────────────── thread CRUD ───────────────────────

pub fn create(db: &Database, p: PlotThreadCreatePayload) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.thread.create", &p.context)?;
    let payload_hash = payload_fingerprint(
        "plot_thread_create",
        &json!({
            "id": p.id,
            "projectId": p.project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "name": p.name,
            "color": p.color,
            "description": p.description,
            "sortOrder": p.sort_order,
        }),
    )?;
    let id = p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let project_id = p.project_id;
    let name = p.name;
    let color = p.color;
    let description = p.description;
    let sort_order = p.sort_order;
    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_create",
            request_id: Some(write_context.request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            Database::execute_with_conn(
                conn,
                "INSERT INTO plot_threads (id, project_id, name, color, description, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)",
                &[
                    Value::String(id.clone()),
                    Value::String(project_id.clone()),
                    Value::String(name.clone()),
                    color.clone().map(Value::String).unwrap_or(Value::Null),
                    description
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    Value::String(sort_order.clone()),
                ],
                "run",
            )
            .or_else(|error| {
                let existing = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM plot_threads WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                let Some(row) = existing.first() else {
                    return Err(error);
                };
                let matches = row.get("project_id").and_then(Value::as_str)
                    == Some(project_id.as_str())
                    && row.get("name").and_then(Value::as_str) == Some(name.as_str())
                    && row.get("color")
                        == Some(&color.clone().map(Value::String).unwrap_or(Value::Null))
                    && row.get("description")
                        == Some(
                            &description
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        )
                    && row.get("sort_order").and_then(Value::as_str) == Some(sort_order.as_str());
                if matches {
                    Ok(Vec::new())
                } else {
                    Err(anyhow::anyhow!(
                        "PLOT_THREAD_IDEMPOTENCY_CONFLICT: request id reused with different payload"
                    ))
                }
            })?;
            let row = one(Database::execute_with_conn(
                conn,
                "SELECT * FROM plot_threads WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?);
            if row.is_null() {
                anyhow::bail!("plot thread create completed without a persisted row");
            }
            record_plot_field_authority(
                conn,
                &project_id,
                "plot-thread",
                &id,
                &[
                    "/name",
                    "/description",
                    "/color",
                    "/sortOrder",
                    "/startNodeId",
                    "/endNodeId",
                ],
            )?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &project_id,
                    operation: "plot.thread.create",
                    entity_type: "plot-thread",
                    entity_id: &id,
                    context: &write_context,
                    cause_kind: write_context.cause_kind,
                    origin: write_context.origin,
                    original_transaction_id: write_context.original_transaction_id.clone(),
                    events: vec![plot_root_feed_event(
                        &id,
                        "catalog",
                        "create",
                        None,
                        Some(&row),
                        vec!["/".to_string()],
                    )?],
                },
            )?;
            Ok((
                project_id.clone(),
                attach_maintenance_transaction_id(row, transaction_id),
            ))
        },
        |conn| load_row(conn, "plot_threads", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn update(db: &Database, id: String, patch: PlotThreadPatch) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.thread.update", &patch.context)?;
    let project_id = patch.project_id.clone();
    let payload_hash = payload_fingerprint(
        "plot_thread_update",
        &json!({
            "id": id,
            "projectId": project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "name": patch.name,
            "color": patch.color,
            "description": patch.description,
            "sortOrder": patch.sort_order,
            "baseVersion": patch.base_version,
        }),
    )?;
    let base_version = patch.base_version;
    let changed_paths = [
        patch.name.is_some().then_some("/name"),
        patch.color.is_some().then_some("/color"),
        patch.description.is_some().then_some("/description"),
        patch.sort_order.is_some().then_some("/sortOrder"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    if let Some(name) = patch.name {
        sets.push("name = ?");
        params.push(Value::String(name));
    }
    if let Some(color) = patch.color {
        sets.push("color = ?");
        params.push(color.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(description) = patch.description {
        sets.push("description = ?");
        params.push(description.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(Value::String(sort_order));
    }
    let has_changes = !sets.is_empty();
    if has_changes {
        sets.push("version = version + 1");
        sets.push("updated_at = datetime('now')");
        params.push(Value::String(id.clone()));
        params.push(Value::Number(base_version.into()));
    }
    let sql = format!(
        "UPDATE plot_threads SET {} WHERE id = ? AND version = ?",
        sets.join(", ")
    );
    let request = IdempotencyRequest {
        domain: "plot_thread_update",
        request_id: Some(write_context.request_id.as_str()),
        payload_hash: &payload_hash,
        conflict_marker: "PLOT_THREAD_UPDATE_IDEMPOTENCY_CONFLICT",
    };
    run_atomic_plot_mutation(db, request, &project_id, |conn| {
        let before = load_row(conn, "plot_threads", &id)?
            .ok_or_else(|| anyhow::anyhow!("plot thread not found: {id}"))?;
        anyhow::ensure!(
            before.get("project_id").and_then(Value::as_str) == Some(project_id.as_str()),
            "plot thread update target belongs to another project"
        );
        let current_version = before.get("version").and_then(Value::as_i64).unwrap_or(0);
        anyhow::ensure!(
            current_version == base_version,
            "PLOT_THREAD_VERSION_MISMATCH: expected {base_version}, found {current_version}"
        );
        if !has_changes {
            return Ok(before);
        }
        Database::execute_with_conn(conn, &sql, &params, "run")?;
        anyhow::ensure!(
            conn.changes() == 1,
            "PLOT_THREAD_VERSION_MISMATCH: expected base version {base_version}"
        );
        let row = one(Database::execute_with_conn(
            conn,
            "SELECT * FROM plot_threads WHERE id = ?",
            &[Value::String(id.clone())],
            "get",
        )?);
        let persisted_project_id = row
            .get("project_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread missing project_id"))?;
        record_plot_field_authority(
            conn,
            persisted_project_id,
            "plot-thread",
            &id,
            &[
                "/name",
                "/description",
                "/color",
                "/sortOrder",
                "/startNodeId",
                "/endNodeId",
            ],
        )?;
        let transaction_id = append_plot_feed(
            conn,
            PlotFeedAppend {
                project_id: persisted_project_id,
                operation: "plot.thread.update",
                entity_type: "plot-thread",
                entity_id: &id,
                context: &write_context,
                cause_kind: write_context.cause_kind,
                origin: write_context.origin,
                original_transaction_id: write_context.original_transaction_id.clone(),
                events: vec![plot_root_feed_event(
                    &id,
                    "metadata",
                    "update",
                    Some(&before),
                    Some(&row),
                    changed_paths.clone(),
                )?],
            },
        )?;
        Ok(attach_maintenance_transaction_id(row, transaction_id))
    })
}

pub fn delete(db: &Database, payload: PlotDeletePayload) -> anyhow::Result<Value> {
    delete_versioned_row(db, "plot_threads", "PLOT_THREAD_VERSION_MISMATCH", payload)
}

pub fn list(db: &Database, project_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT * FROM plot_threads WHERE project_id = ? ORDER BY sort_order ASC",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

// ─────────────────────── link CRUD ───────────────────────

pub fn link_create(db: &Database, p: PlotThreadLinkCreatePayload) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.marker.create", &p.context)?;
    let payload_hash = payload_fingerprint(
        "plot_thread_link_create",
        &json!({
            "id": p.id,
            "projectId": p.project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "threadId": p.thread_id,
            "nodeId": p.node_id,
            "phaseType": p.phase_type,
            "note": p.note,
            "sortOrder": p.sort_order,
        }),
    )?;
    let id = p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let requested_project_id = p.project_id;
    let thread_id = p.thread_id;
    let node_id = p.node_id;
    let phase_type = p.phase_type;
    let note = p.note;
    let sort_order = p.sort_order;
    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_link_create",
            request_id: Some(write_context.request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            validate_phase(&phase_type)?;
            // XPROJ is evaluated after the durable replay lookup. An exact
            // replay can therefore return its original response even when a
            // later cascade removed the thread or scene.
            let project_id = project_of_conn(conn, "plot_threads", &thread_id)?
                .ok_or_else(|| anyhow::anyhow!("plot thread link thread does not exist"))?;
            anyhow::ensure!(
                project_id == requested_project_id.as_str(),
                "plot thread link must belong to payload project"
            );
            require_project_scene(conn, &node_id, &project_id, "plot thread link scene")?;
            let semantic_key = format!("{thread_id}|{node_id}|{phase_type}");
            Database::execute_with_conn(
                conn,
                "INSERT INTO plot_thread_scene_links
                     (id, thread_id, node_id, phase_type, note, sort_order, semantic_key, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                &[
                    Value::String(id.clone()),
                    Value::String(thread_id.clone()),
                    Value::String(node_id.clone()),
                    Value::String(phase_type.clone()),
                    note.clone().map(Value::String).unwrap_or(Value::Null),
                    sort_order
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                    Value::String(semantic_key),
                ],
                "run",
            )
            .or_else(|error| {
                let existing = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM plot_thread_scene_links WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                let Some(row) = existing.first() else {
                    return Err(error);
                };
                let matches = row.get("thread_id").and_then(Value::as_str)
                    == Some(thread_id.as_str())
                    && row.get("node_id").and_then(Value::as_str)
                        == Some(node_id.as_str())
                    && row.get("phase_type").and_then(Value::as_str)
                        == Some(phase_type.as_str())
                    && row.get("note")
                        == Some(&note.clone().map(Value::String).unwrap_or(Value::Null))
                    && row.get("sort_order")
                        == Some(
                            &sort_order
                                .clone()
                                .map(Value::String)
                                .unwrap_or(Value::Null),
                        );
                if matches {
                    Ok(Vec::new())
                } else {
                    Err(anyhow::anyhow!(
                        "PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT: request id reused with different payload"
                    ))
                }
            })?;
            let row = one(Database::execute_with_conn(
                conn,
                "SELECT * FROM plot_thread_scene_links WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?);
            if row.is_null() {
                anyhow::bail!("plot thread link create completed without a persisted row");
            }
            record_plot_field_authority(
                conn,
                &project_id,
                "plot-marker",
                &id,
                &[
                    "/threadId",
                    "/sceneId",
                    "/phaseType",
                    "/note",
                    "/sortOrder",
                    "/semanticKey",
                ],
            )?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &project_id,
                    operation: "plot.marker.create",
                    entity_type: "plot-marker",
                    entity_id: &id,
                    context: &write_context,
                    cause_kind: write_context.cause_kind,
                    origin: write_context.origin,
                    original_transaction_id: write_context.original_transaction_id.clone(),
                    events: vec![plot_marker_feed_event(
                        &id,
                        "association",
                        "create",
                        None,
                        Some(&row),
                        vec!["/".to_string()],
                    )?],
                },
            )?;
            Ok((
                project_id,
                attach_maintenance_transaction_id(row, transaction_id),
            ))
        },
        |conn| load_row(conn, "plot_thread_scene_links", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn link_update(db: &Database, id: String, patch: PlotThreadLinkPatch) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.marker.update", &patch.context)?;
    let project_id = patch.project_id.clone();
    let payload_hash = payload_fingerprint(
        "plot_thread_link_update",
        &json!({
            "id": id,
            "projectId": project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "threadId": patch.thread_id,
            "nodeId": patch.node_id,
            "phaseType": patch.phase_type,
            "note": patch.note,
            "sortOrder": patch.sort_order,
            "baseVersion": patch.base_version,
        }),
    )?;
    let base_version = patch.base_version;
    let changed_paths = [
        patch.thread_id.is_some().then_some("/threadId"),
        patch.node_id.is_some().then_some("/sceneId"),
        patch.phase_type.is_some().then_some("/phaseType"),
        patch.note.is_some().then_some("/note"),
        patch.sort_order.is_some().then_some("/sortOrder"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_string)
    .collect::<Vec<_>>();
    if let Some(ref pt) = patch.phase_type {
        validate_phase(pt)?;
    }
    let has_changes = patch.thread_id.is_some()
        || patch.node_id.is_some()
        || patch.phase_type.is_some()
        || patch.note.is_some()
        || patch.sort_order.is_some();
    let request = IdempotencyRequest {
        domain: "plot_thread_link_update",
        request_id: Some(write_context.request_id.as_str()),
        payload_hash: &payload_hash,
        conflict_marker: "PLOT_THREAD_LINK_UPDATE_IDEMPOTENCY_CONFLICT",
    };
    run_atomic_plot_mutation(db, request, &project_id, |conn| {
        let current_rows = Database::execute_with_conn(
            conn,
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id.clone())],
            "get",
        )?;
        let current = current_rows
            .first()
            .ok_or_else(|| anyhow::anyhow!("plot thread link not found: {id}"))?;
        let before = Value::Object(current.clone());
        let current_thread_id = current
            .get("thread_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread link missing thread_id"))?;
        let current_node_id = current
            .get("node_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread link missing node_id"))?;
        let current_phase_type = current
            .get("phase_type")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread link missing phase_type"))?;
        let current_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
        anyhow::ensure!(
            current_version == base_version,
            "PLOT_THREAD_LINK_VERSION_MISMATCH: expected {base_version}, found {current_version}"
        );

        let current_project = project_of_conn(conn, "plot_threads", current_thread_id)?;
        anyhow::ensure!(
            current_project.as_deref() == Some(project_id.as_str()),
            "plot thread link update target belongs to another project"
        );
        if !has_changes {
            return Ok(before);
        }

        let thread_id = patch.thread_id.as_deref().unwrap_or(current_thread_id);
        let node_id = patch.node_id.as_deref().unwrap_or(current_node_id);
        let phase_type = patch.phase_type.as_deref().unwrap_or(current_phase_type);
        let thread_project = project_of_conn(conn, "plot_threads", thread_id)?;
        let project_id = match (current_project, thread_project) {
            (Some(current_project), Some(thread_project)) if current_project == thread_project => {
                current_project
            }
            _ => anyhow::bail!("plot thread link move must stay within the same project"),
        };
        require_project_scene(conn, node_id, &project_id, "plot thread link scene")?;

        let note = patch
            .note
            .clone()
            .map(|value| value.map(Value::String).unwrap_or(Value::Null))
            .unwrap_or_else(|| current.get("note").cloned().unwrap_or(Value::Null));
        let sort_order = patch
            .sort_order
            .clone()
            .map(|value| value.map(Value::String).unwrap_or(Value::Null))
            .unwrap_or_else(|| current.get("sort_order").cloned().unwrap_or(Value::Null));
        let natural_key = format!("{thread_id}|{node_id}|{phase_type}");
        let current_key = current
            .get("semantic_key")
            .and_then(Value::as_str)
            .unwrap_or("");
        let semantic_key = if current_key == natural_key
            || current_key
                .strip_prefix(&natural_key)
                .is_some_and(|suffix| suffix.starts_with("#dup:"))
        {
            current_key.to_string()
        } else {
            natural_key
        };

        Database::execute_with_conn(
            conn,
            "UPDATE plot_thread_scene_links
                    SET thread_id = ?, node_id = ?, phase_type = ?, note = ?, sort_order = ?,
                        semantic_key = ?, version = version + 1, updated_at = datetime('now')
                  WHERE id = ? AND version = ?",
            &[
                Value::String(thread_id.to_string()),
                Value::String(node_id.to_string()),
                Value::String(phase_type.to_string()),
                note,
                sort_order,
                Value::String(semantic_key),
                Value::String(id.clone()),
                Value::Number(base_version.into()),
            ],
            "run",
        )?;
        anyhow::ensure!(
            conn.changes() == 1,
            "PLOT_THREAD_LINK_VERSION_MISMATCH: link changed during update"
        );
        let row = one(Database::execute_with_conn(
            conn,
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id.clone())],
            "get",
        )?);
        let project_id = project_of_conn(conn, "plot_threads", current_thread_id)?
            .ok_or_else(|| anyhow::anyhow!("plot thread link project missing"))?;
        record_plot_field_authority(
            conn,
            &project_id,
            "plot-marker",
            &id,
            &[
                "/threadId",
                "/sceneId",
                "/phaseType",
                "/note",
                "/sortOrder",
                "/semanticKey",
            ],
        )?;
        let event = plot_marker_feed_event(
            &id,
            "association",
            "update",
            Some(&before),
            Some(&row),
            changed_paths.clone(),
        )?;
        let transaction_id = append_plot_feed(
            conn,
            PlotFeedAppend {
                project_id: &project_id,
                operation: "plot.marker.update",
                entity_type: "plot-marker",
                entity_id: &id,
                context: &write_context,
                cause_kind: write_context.cause_kind,
                origin: write_context.origin,
                original_transaction_id: write_context.original_transaction_id.clone(),
                events: vec![event],
            },
        )?;
        Ok(attach_maintenance_transaction_id(row, transaction_id))
    })
}

pub fn link_delete(db: &Database, payload: PlotDeletePayload) -> anyhow::Result<Value> {
    delete_versioned_row(
        db,
        "plot_thread_scene_links",
        "PLOT_THREAD_LINK_VERSION_MISMATCH",
        payload,
    )
}

pub fn list_links(db: &Database, project_id: String) -> anyhow::Result<Vec<Value>> {
    let rows = db.execute(
        "SELECT l.* FROM plot_thread_scene_links l \
         JOIN plot_threads t ON t.id = l.thread_id \
         WHERE t.project_id = ?",
        &[Value::String(project_id)],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
}

// ─────────────────────── branch create ───────────────────────

/// Create a plot branch through the native domain boundary. Renderer mutations
/// own XPROJ/OCC validation and append their canonical + maintenance Feed facts
/// inside the same native transaction.
pub fn branch_create(db: &Database, p: PlotThreadBranchCreatePayload) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.branch.create", &p.context)?;
    let payload_hash = payload_fingerprint(
        "plot_thread_branch_create",
        &json!({
            "id": p.id,
            "projectId": p.project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "fromThreadId": p.from_thread_id,
            "toThreadId": p.to_thread_id,
            "atNodeId": p.at_node_id,
            "kind": p.kind,
        }),
    )?;
    let id = p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let project_id = p.project_id;
    let from_thread_id = p.from_thread_id;
    let to_thread_id = p.to_thread_id;
    let at_node_id = p.at_node_id;
    let kind = p.kind;

    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_branch_create",
            request_id: Some(write_context.request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            validate_branch_kind(&kind)?;
            if from_thread_id == to_thread_id {
                anyhow::bail!("plot thread branch cannot reference the same thread twice");
            }
            let from_project = project_of_conn(conn, "plot_threads", &from_thread_id)?;
            let to_project = project_of_conn(conn, "plot_threads", &to_thread_id)?;
            match (from_project, to_project) {
                (Some(from), Some(to)) if from == project_id && to == project_id => {}
                _ => anyhow::bail!(
                    "plot thread branch must reference a project, threads, and scene in the same project"
                ),
            }
            require_project_scene(conn, &at_node_id, &project_id, "plot thread branch scene")?;

            let semantic_key = format!(
                "{from_thread_id}|{to_thread_id}|{at_node_id}|{kind}"
            );
            Database::execute_with_conn(
                conn,
                "INSERT INTO plot_thread_branches
                     (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                      semantic_key, version)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                &[
                    Value::String(id.clone()),
                    Value::String(project_id.clone()),
                    Value::String(from_thread_id.clone()),
                    Value::String(to_thread_id.clone()),
                    Value::String(at_node_id.clone()),
                    Value::String(kind.clone()),
                    Value::String(semantic_key),
                ],
                "run",
            )
            .or_else(|error| {
                let existing = Database::execute_with_conn(
                    conn,
                    "SELECT * FROM plot_thread_branches WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                let Some(row) = existing.first() else {
                    return Err(error);
                };
                let matches = row.get("project_id").and_then(Value::as_str)
                    == Some(project_id.as_str())
                    && row.get("from_thread_id").and_then(Value::as_str)
                        == Some(from_thread_id.as_str())
                    && row.get("to_thread_id").and_then(Value::as_str)
                        == Some(to_thread_id.as_str())
                    && row.get("at_node_id").and_then(Value::as_str)
                        == Some(at_node_id.as_str())
                    && row.get("kind").and_then(Value::as_str) == Some(kind.as_str());
                if matches {
                    Ok(Vec::new())
                } else {
                    Err(anyhow::anyhow!(
                        "PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT: request id reused with different payload"
                    ))
                }
            })?;
            let row = one(Database::execute_with_conn(
                conn,
                "SELECT * FROM plot_thread_branches WHERE id = ?",
                &[Value::String(id.clone())],
                "get",
            )?);
            if row.is_null() {
                anyhow::bail!("plot thread branch create completed without a persisted row");
            }
            record_plot_field_authority(
                conn,
                &project_id,
                "plot-branch",
                &id,
                &[
                    "/fromThreadId",
                    "/toThreadId",
                    "/atSceneId",
                    "/kind",
                    "/semanticKey",
                ],
            )?;
            let event = plot_branch_feed_event(
                &id,
                "association",
                "create",
                None,
                Some(&row),
                vec!["/".to_string()],
            )?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &project_id,
                    operation: "plot.branch.create",
                    entity_type: "plot-branch",
                    entity_id: &id,
                    context: &write_context,
                    cause_kind: write_context.cause_kind,
                    origin: write_context.origin,
                    original_transaction_id: write_context.original_transaction_id.clone(),
                    events: vec![event],
                },
            )?;
            Ok((
                project_id.clone(),
                attach_maintenance_transaction_id(row, transaction_id),
            ))
        },
        |conn| load_row(conn, "plot_thread_branches", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn branch_update(
    db: &Database,
    id: String,
    patch: PlotThreadBranchPatch,
) -> anyhow::Result<Value> {
    let write_context = resolve_write_context("plot.branch.update", &patch.context)?;
    let requested_project_id = patch.project_id.clone();
    let payload_hash = payload_fingerprint(
        "plot_thread_branch_update",
        &json!({
            "id": id,
            "projectId": requested_project_id,
            "origin": write_context.origin,
            "originalTransactionId": write_context.original_transaction_id,
            "fromThreadId": patch.from_thread_id,
            "toThreadId": patch.to_thread_id,
            "atNodeId": patch.at_node_id,
            "baseVersion": patch.base_version,
        }),
    )?;
    let changed_paths = [
        patch.from_thread_id.is_some().then_some("/fromThreadId"),
        patch.to_thread_id.is_some().then_some("/toThreadId"),
        patch.at_node_id.is_some().then_some("/atSceneId"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let has_changes = patch.from_thread_id.is_some()
        || patch.to_thread_id.is_some()
        || patch.at_node_id.is_some();
    let request = IdempotencyRequest {
        domain: "plot_thread_branch_update",
        request_id: Some(write_context.request_id.as_str()),
        payload_hash: &payload_hash,
        conflict_marker: "PLOT_THREAD_BRANCH_UPDATE_IDEMPOTENCY_CONFLICT",
    };
    run_atomic_plot_mutation(db, request, &requested_project_id, |conn| {
        let current_rows = Database::execute_with_conn(
            conn,
            "SELECT * FROM plot_thread_branches WHERE id = ?",
            &[Value::String(id.clone())],
            "get",
        )?;
        let Some(current) = current_rows.first() else {
            anyhow::bail!("plot thread branch not found: {id}");
        };
        let before = Value::Object(current.clone());
        let current_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
        anyhow::ensure!(
            current_version == patch.base_version,
            "PLOT_THREAD_BRANCH_VERSION_MISMATCH: expected {}, found {current_version}",
            patch.base_version
        );

        let project_id = current
            .get("project_id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread branch missing project_id"))?;
        anyhow::ensure!(
            project_id == requested_project_id,
            "plot thread branch update target belongs to another project"
        );
        if !has_changes {
            return Ok(before);
        }
        let kind = current
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot thread branch missing kind"))?;
        let from_thread_id = patch.from_thread_id.as_deref().unwrap_or_else(|| {
            current
                .get("from_thread_id")
                .and_then(Value::as_str)
                .unwrap_or("")
        });
        let to_thread_id = patch.to_thread_id.as_deref().unwrap_or_else(|| {
            current
                .get("to_thread_id")
                .and_then(Value::as_str)
                .unwrap_or("")
        });
        let at_node_id = patch.at_node_id.as_deref().unwrap_or_else(|| {
            current
                .get("at_node_id")
                .and_then(Value::as_str)
                .unwrap_or("")
        });
        anyhow::ensure!(
            from_thread_id != to_thread_id,
            "plot thread branch cannot reference the same thread twice"
        );

        let from_project = project_of_conn(conn, "plot_threads", from_thread_id)?;
        let to_project = project_of_conn(conn, "plot_threads", to_thread_id)?;
        match (from_project, to_project) {
                (Some(from), Some(to)) if from == project_id && to == project_id => {}
                _ => anyhow::bail!(
                    "plot thread branch must reference a project, threads, and scene in the same project"
                ),
            }
        require_project_scene(conn, at_node_id, project_id, "plot thread branch scene")?;

        let natural_key = format!("{from_thread_id}|{to_thread_id}|{at_node_id}|{kind}");
        let current_key = current
            .get("semantic_key")
            .and_then(Value::as_str)
            .unwrap_or("");
        let semantic_key = if current_key == natural_key
            || current_key
                .strip_prefix(&natural_key)
                .is_some_and(|suffix| suffix.starts_with("#dup:"))
        {
            current_key.to_string()
        } else {
            natural_key
        };
        Database::execute_with_conn(
            conn,
            "UPDATE plot_thread_branches
                    SET from_thread_id = ?, to_thread_id = ?, at_node_id = ?,
                        semantic_key = ?, version = version + 1, updated_at = datetime('now')
                  WHERE id = ? AND version = ?",
            &[
                Value::String(from_thread_id.to_string()),
                Value::String(to_thread_id.to_string()),
                Value::String(at_node_id.to_string()),
                Value::String(semantic_key),
                Value::String(id.clone()),
                Value::Number(current_version.into()),
            ],
            "run",
        )?;
        anyhow::ensure!(
            conn.changes() == 1,
            "PLOT_THREAD_BRANCH_VERSION_MISMATCH: branch changed during update"
        );
        let row = one(Database::execute_with_conn(
            conn,
            "SELECT * FROM plot_thread_branches WHERE id = ?",
            &[Value::String(id.clone())],
            "get",
        )?);
        record_plot_field_authority(
            conn,
            project_id,
            "plot-branch",
            &id,
            &[
                "/fromThreadId",
                "/toThreadId",
                "/atSceneId",
                "/kind",
                "/semanticKey",
            ],
        )?;
        let event = plot_branch_feed_event(
            &id,
            "association",
            "update",
            Some(&before),
            Some(&row),
            changed_paths.clone(),
        )?;
        let transaction_id = append_plot_feed(
            conn,
            PlotFeedAppend {
                project_id,
                operation: "plot.branch.update",
                entity_type: "plot-branch",
                entity_id: &id,
                context: &write_context,
                cause_kind: write_context.cause_kind,
                origin: write_context.origin,
                original_transaction_id: write_context.original_transaction_id.clone(),
                events: vec![event],
            },
        )?;
        Ok(attach_maintenance_transaction_id(row, transaction_id))
    })
}

pub fn branch_delete(db: &Database, payload: PlotDeletePayload) -> anyhow::Result<Value> {
    delete_versioned_row(
        db,
        "plot_thread_branches",
        "PLOT_THREAD_BRANCH_VERSION_MISMATCH",
        payload,
    )
}

fn validate_move_link_row(label: &str, row: &PlotThreadLinkSnapshotRow) -> anyhow::Result<()> {
    anyhow::ensure!(
        row.version >= 0,
        "plot marker move {label}.version must be non-negative"
    );
    validate_snapshot_semantic_key(
        &row.semantic_key,
        &link_natural_key(row),
        &format!("plot marker move {label}"),
    )?;
    for (field, value) in [
        ("id", row.id.as_str()),
        ("threadId", row.thread_id.as_str()),
        ("nodeId", row.node_id.as_str()),
        ("phaseType", row.phase_type.as_str()),
        ("createdAt", row.created_at.as_str()),
        ("updatedAt", row.updated_at.as_str()),
    ] {
        if value.is_empty() {
            anyhow::bail!("plot marker move {label}.{field} must be non-empty");
        }
    }
    validate_phase(&row.phase_type)
}

fn validate_move_branch_row(
    label: &str,
    row: &PlotThreadBranchSnapshotRow,
    project_id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        row.version >= 0,
        "plot marker move {label}.version must be non-negative"
    );
    validate_snapshot_semantic_key(
        &row.semantic_key,
        &branch_natural_key(row),
        &format!("plot marker move {label}"),
    )?;
    for (field, value) in [
        ("id", row.id.as_str()),
        ("projectId", row.project_id.as_str()),
        ("fromThreadId", row.from_thread_id.as_str()),
        ("toThreadId", row.to_thread_id.as_str()),
        ("atNodeId", row.at_node_id.as_str()),
        ("kind", row.kind.as_str()),
        ("createdAt", row.created_at.as_str()),
        ("updatedAt", row.updated_at.as_str()),
    ] {
        if value.is_empty() {
            anyhow::bail!("plot marker move {label}.{field} must be non-empty");
        }
    }
    if row.project_id != project_id {
        anyhow::bail!("plot marker move branch must belong to the bundle project");
    }
    if row.from_thread_id == row.to_thread_id {
        anyhow::bail!("plot thread branch cannot reference the same thread twice");
    }
    validate_branch_kind(&row.kind)
}

fn normalize_move_marker_bundle(
    payload: &mut PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<()> {
    payload.marker_before.semantic_key = Some(link_semantic_key(&payload.marker_before));
    payload.marker_after.semantic_key = Some(link_semantic_key(&payload.marker_after));
    payload.marker_after.version = payload
        .marker_before
        .version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot marker version overflow"))?;
    for transition in &mut payload.branch_transitions {
        if let Some(before) = &mut transition.before {
            before.semantic_key = Some(branch_semantic_key(before));
        }
        if let Some(after) = &mut transition.after {
            after.semantic_key = Some(branch_semantic_key(after));
            if let Some(before) = &transition.before {
                after.version = before
                    .version
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("plot branch version overflow"))?;
            }
        }
    }
    Ok(())
}

fn validate_move_marker_bundle_shape(
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<()> {
    if payload.request_id.is_empty() {
        anyhow::bail!("plot marker move requestId must be non-empty");
    }
    if payload.project_id.is_empty() {
        anyhow::bail!("plot marker move projectId must be non-empty");
    }
    validate_move_link_row("markerBefore", &payload.marker_before)?;
    validate_move_link_row("markerAfter", &payload.marker_after)?;
    if payload.marker_before.id != payload.marker_after.id {
        anyhow::bail!("plot marker move marker identity cannot change");
    }
    anyhow::ensure!(
        payload.marker_after.version == payload.marker_before.version + 1,
        "plot marker move marker version must advance exactly once"
    );
    if payload.marker_before.phase_type != payload.marker_after.phase_type
        || payload.marker_before.note != payload.marker_after.note
        || payload.marker_before.sort_order != payload.marker_after.sort_order
        || payload.marker_before.created_at != payload.marker_after.created_at
    {
        anyhow::bail!("plot marker move may only change marker thread, scene, and updatedAt");
    }

    let mut branch_ids = HashSet::new();
    for (index, transition) in payload.branch_transitions.iter().enumerate() {
        if transition.before.is_none() && transition.after.is_none() {
            anyhow::bail!("plot marker move branch transition must contain before or after");
        }
        if let Some(before) = &transition.before {
            validate_move_branch_row(
                &format!("branchTransitions[{index}].before"),
                before,
                &payload.project_id,
            )?;
            anyhow::ensure!(
                before.to_thread_id == payload.marker_before.thread_id
                    && before.at_node_id == payload.marker_before.node_id,
                "plot marker move before branch must depend on markerBefore"
            );
        }
        if let Some(after) = &transition.after {
            validate_move_branch_row(
                &format!("branchTransitions[{index}].after"),
                after,
                &payload.project_id,
            )?;
            anyhow::ensure!(
                after.to_thread_id == payload.marker_after.thread_id
                    && after.at_node_id == payload.marker_after.node_id,
                "plot marker move after branch must depend on markerAfter"
            );
        }
        let id = transition
            .before
            .as_ref()
            .map(|row| row.id.as_str())
            .or_else(|| transition.after.as_ref().map(|row| row.id.as_str()))
            .ok_or_else(|| anyhow::anyhow!("plot marker move branch transition has no identity"))?;
        if let (Some(before), Some(after)) = (&transition.before, &transition.after) {
            if before.id != after.id {
                anyhow::bail!("plot marker move branch identity cannot change");
            }
            if before.project_id != after.project_id
                || before.kind != after.kind
                || before.created_at != after.created_at
            {
                anyhow::bail!(
                    "plot marker move may only change branch endpoints, anchor, and updatedAt"
                );
            }
            anyhow::ensure!(
                after.version == before.version + 1,
                "plot marker move branch version must advance exactly once"
            );
        }
        if !branch_ids.insert(id.to_string()) {
            anyhow::bail!("plot marker move contains duplicate branch ids");
        }
    }
    Ok(())
}

fn validate_move_marker_bundle_membership(
    conn: &Connection,
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<()> {
    require_project(conn, &payload.project_id)?;
    for marker in [&payload.marker_before, &payload.marker_after] {
        require_project_member(
            conn,
            "plot_threads",
            &marker.thread_id,
            &payload.project_id,
            "plot marker move thread",
        )?;
        require_project_scene(
            conn,
            &marker.node_id,
            &payload.project_id,
            "plot marker move scene",
        )?;
    }
    for transition in &payload.branch_transitions {
        for branch in [&transition.before, &transition.after]
            .into_iter()
            .flatten()
        {
            require_project_member(
                conn,
                "plot_threads",
                &branch.from_thread_id,
                &payload.project_id,
                "plot marker move branch source thread",
            )?;
            require_project_member(
                conn,
                "plot_threads",
                &branch.to_thread_id,
                &payload.project_id,
                "plot marker move branch target thread",
            )?;
            require_project_scene(
                conn,
                &branch.at_node_id,
                &payload.project_id,
                "plot marker move branch scene",
            )?;
        }
    }
    Ok(())
}

fn validate_move_marker_dependency_set(
    conn: &Connection,
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<()> {
    if payload.marker_before.thread_id == payload.marker_after.thread_id
        && payload.marker_before.node_id == payload.marker_after.node_id
    {
        return Ok(());
    }

    let other_markers: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_scene_links
          WHERE id <> ?1 AND thread_id = ?2 AND node_id = ?3",
        rusqlite::params![
            payload.marker_before.id,
            payload.marker_before.thread_id,
            payload.marker_before.node_id,
        ],
        |row| row.get(0),
    )?;
    let live_ids = if other_markers > 0 {
        HashSet::new()
    } else {
        let mut statement = conn.prepare(
            "SELECT id FROM plot_thread_branches
              WHERE to_thread_id = ?1 AND at_node_id = ?2",
        )?;
        let ids = statement
            .query_map(
                rusqlite::params![
                    payload.marker_before.thread_id,
                    payload.marker_before.node_id,
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<HashSet<_>, _>>()?;
        ids
    };
    let expected_ids = payload
        .branch_transitions
        .iter()
        .filter_map(|transition| transition.before.as_ref())
        .filter(|branch| {
            branch.to_thread_id == payload.marker_before.thread_id
                && branch.at_node_id == payload.marker_before.node_id
        })
        .map(|branch| branch.id.clone())
        .collect::<HashSet<_>>();
    anyhow::ensure!(
        live_ids == expected_ids,
        "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: dependent branch set changed since snapshot"
    );
    Ok(())
}

fn move_marker_bundle_response(
    request_id: &str,
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> Value {
    let branches = payload
        .branch_transitions
        .iter()
        .filter_map(|transition| transition.after.clone())
        .collect::<Vec<_>>();
    let deleted_branch_ids = payload
        .branch_transitions
        .iter()
        .filter(|transition| transition.after.is_none())
        .filter_map(|transition| transition.before.as_ref().map(|row| row.id.clone()))
        .collect::<Vec<_>>();
    json!({
        "id": request_id,
        "marker": payload.marker_after,
        "branches": branches,
        "deletedBranchIds": deleted_branch_ids,
    })
}

fn move_marker_feed_events(
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let marker_before = serde_json::to_value(&payload.marker_before)?;
    let marker_after = serde_json::to_value(&payload.marker_after)?;
    let mut ordered = vec![(
        0_u8,
        payload.marker_before.id.clone(),
        plot_marker_feed_event(
            &payload.marker_before.id,
            "association",
            "update",
            Some(&marker_before),
            Some(&marker_after),
            marker_transition_changed_paths(&payload.marker_before, &payload.marker_after),
        )?,
    )];
    for transition in &payload.branch_transitions {
        let branch = transition
            .after
            .as_ref()
            .or(transition.before.as_ref())
            .ok_or_else(|| anyhow::anyhow!("plot marker move branch transition has no row"))?;
        let before = transition
            .before
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let after = transition
            .after
            .as_ref()
            .map(serde_json::to_value)
            .transpose()?;
        let mutation_kind = match (&before, &after) {
            (None, Some(_))
                if matches!(
                    payload.origin,
                    NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
                ) =>
            {
                "restore"
            }
            (None, Some(_)) => "create",
            (Some(_), Some(_)) => "update",
            (Some(_), None) => "delete",
            (None, None) => anyhow::bail!("plot marker move branch transition has no state"),
        };
        let changed_paths = match (&transition.before, &transition.after) {
            (Some(before), Some(after)) => branch_transition_changed_paths(before, after),
            _ => vec!["/".to_string()],
        };
        ordered.push((
            1_u8,
            branch.id.clone(),
            plot_branch_feed_event(
                &branch.id,
                "association",
                mutation_kind,
                before.as_ref(),
                after.as_ref(),
                changed_paths,
            )?,
        ));
    }
    ordered.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));
    Ok(ordered.into_iter().map(|(_, _, event)| event).collect())
}

fn marker_transition_changed_paths(
    before: &PlotThreadLinkSnapshotRow,
    after: &PlotThreadLinkSnapshotRow,
) -> Vec<String> {
    let mut paths = Vec::new();
    if before.thread_id != after.thread_id {
        paths.push("/threadId".to_string());
    }
    if before.node_id != after.node_id {
        paths.push("/sceneId".to_string());
    }
    if before.phase_type != after.phase_type {
        paths.push("/phaseType".to_string());
    }
    if before.note != after.note {
        paths.push("/note".to_string());
    }
    if before.sort_order != after.sort_order {
        paths.push("/sortOrder".to_string());
    }
    if before.semantic_key != after.semantic_key {
        paths.push("/semanticKey".to_string());
    }
    if paths.is_empty() {
        paths.push("/".to_string());
    }
    paths
}

fn branch_transition_changed_paths(
    before: &PlotThreadBranchSnapshotRow,
    after: &PlotThreadBranchSnapshotRow,
) -> Vec<String> {
    let mut paths = Vec::new();
    if before.from_thread_id != after.from_thread_id {
        paths.push("/fromThreadId".to_string());
    }
    if before.to_thread_id != after.to_thread_id {
        paths.push("/toThreadId".to_string());
    }
    if before.at_node_id != after.at_node_id {
        paths.push("/atSceneId".to_string());
    }
    if before.kind != after.kind {
        paths.push("/kind".to_string());
    }
    if before.semantic_key != after.semantic_key {
        paths.push("/semanticKey".to_string());
    }
    if paths.is_empty() {
        paths.push("/".to_string());
    }
    paths
}

fn move_marker_bundle_effect_present(
    conn: &Connection,
    request_id: &str,
    payload: &PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<Option<Value>> {
    let Some(marker) = load_map(conn, "plot_thread_scene_links", &payload.marker_after.id)? else {
        return Ok(None);
    };
    if !link_row_matches(&marker, &payload.marker_after) {
        return Ok(None);
    }
    for transition in &payload.branch_transitions {
        match &transition.after {
            Some(after) => {
                let Some(current) = load_map(conn, "plot_thread_branches", &after.id)? else {
                    return Ok(None);
                };
                if !branch_row_matches(&current, after) {
                    return Ok(None);
                }
            }
            None => {
                let id = &transition
                    .before
                    .as_ref()
                    .ok_or_else(|| {
                        anyhow::anyhow!("plot marker move branch transition has no identity")
                    })?
                    .id;
                if load_row(conn, "plot_thread_branches", id)?.is_some() {
                    return Ok(None);
                }
            }
        }
    }
    Ok(Some(move_marker_bundle_response(request_id, payload)))
}

fn replace_link_row(
    conn: &Connection,
    before: &PlotThreadLinkSnapshotRow,
    after: &PlotThreadLinkSnapshotRow,
) -> anyhow::Result<()> {
    Database::execute_with_conn(
        conn,
        "UPDATE plot_thread_scene_links
            SET thread_id = ?, node_id = ?, phase_type = ?, note = ?,
                sort_order = ?, semantic_key = ?, version = ?,
                created_at = ?, updated_at = ?
          WHERE id = ? AND version = ?",
        &[
            Value::String(after.thread_id.clone()),
            Value::String(after.node_id.clone()),
            Value::String(after.phase_type.clone()),
            nullable_string_value(&after.note),
            nullable_string_value(&after.sort_order),
            Value::String(link_semantic_key(after)),
            Value::Number(after.version.into()),
            Value::String(after.created_at.clone()),
            Value::String(after.updated_at.clone()),
            Value::String(after.id.clone()),
            Value::Number(before.version.into()),
        ],
        "run",
    )?;
    anyhow::ensure!(
        conn.changes() == 1,
        "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker version changed"
    );
    Ok(())
}

fn replace_branch_row(
    conn: &Connection,
    before: &PlotThreadBranchSnapshotRow,
    after: &PlotThreadBranchSnapshotRow,
) -> anyhow::Result<()> {
    Database::execute_with_conn(
        conn,
        "UPDATE plot_thread_branches
            SET project_id = ?, from_thread_id = ?, to_thread_id = ?,
                at_node_id = ?, kind = ?, semantic_key = ?, version = ?,
                created_at = ?, updated_at = ?
          WHERE id = ? AND version = ?",
        &[
            Value::String(after.project_id.clone()),
            Value::String(after.from_thread_id.clone()),
            Value::String(after.to_thread_id.clone()),
            Value::String(after.at_node_id.clone()),
            Value::String(after.kind.clone()),
            Value::String(branch_semantic_key(after)),
            Value::Number(after.version.into()),
            Value::String(after.created_at.clone()),
            Value::String(after.updated_at.clone()),
            Value::String(after.id.clone()),
            Value::Number(before.version.into()),
        ],
        "run",
    )?;
    anyhow::ensure!(
        conn.changes() == 1,
        "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch version changed"
    );
    Ok(())
}

fn reject_duplicate_branch_topology(
    conn: &Connection,
    rows: impl Iterator<Item = PlotThreadBranchSnapshotRow>,
) -> anyhow::Result<()> {
    for row in rows {
        let count = Database::execute_with_conn(
            conn,
            "SELECT COUNT(*) AS count
               FROM plot_thread_branches
              WHERE project_id = ? AND from_thread_id = ? AND to_thread_id = ?
                AND at_node_id = ? AND kind = ? AND id <> ?",
            &[
                Value::String(row.project_id),
                Value::String(row.from_thread_id),
                Value::String(row.to_thread_id),
                Value::String(row.at_node_id),
                Value::String(row.kind),
                Value::String(row.id),
            ],
            "get",
        )?
        .first()
        .and_then(|result| result.get("count"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
        if count > 0 {
            anyhow::bail!("plot marker move would create a duplicate branch");
        }
    }
    Ok(())
}

/// Atomically move one marker and create/update/delete all dependent branches.
/// The request ledger is committed in the same transaction, so renderer retries
/// after an unknown IPC outcome cannot apply only part of the drag twice.
pub fn move_marker_bundle(
    db: &Database,
    mut payload: PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<Value> {
    normalize_move_marker_bundle(&mut payload)?;
    validate_move_marker_bundle_shape(&payload)?;
    let request_id = payload.request_id.clone();
    let write_context = resolve_write_context(
        "plot.marker.move",
        &RendererWriteContext {
            request_id: request_id.clone(),
            session_id: payload.session_id.clone(),
            event_uid: payload.event_uid.clone(),
            origin: payload.origin,
            original_transaction_id: payload.original_transaction_id.clone(),
        },
    )?;
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "origin": write_context.origin,
        "originalTransactionId": write_context.original_transaction_id,
        "markerBefore": payload.marker_before,
        "markerAfter": payload.marker_after,
        "branchTransitions": payload.branch_transitions,
    });
    let payload_hash = payload_fingerprint("plot_thread_move_marker_bundle", &fingerprint_payload)?;

    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_move_marker_bundle",
            request_id: Some(request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_MOVE_MARKER_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            validate_move_marker_bundle_membership(conn, &payload)?;
            let current_marker = load_map(
                conn,
                "plot_thread_scene_links",
                &payload.marker_before.id,
            )?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker no longer exists"
                )
            })?;
            if !link_row_matches(&current_marker, &payload.marker_before) {
                anyhow::bail!(
                    "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: marker changed since snapshot"
                );
            }
            validate_move_marker_dependency_set(conn, &payload)?;
            for transition in &payload.branch_transitions {
                match &transition.before {
                    Some(before) => {
                        let current =
                            load_map(conn, "plot_thread_branches", &before.id)?.ok_or_else(
                                || {
                                    anyhow::anyhow!(
                                        "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch no longer exists"
                                    )
                                },
                            )?;
                        if !branch_row_matches(&current, before) {
                            anyhow::bail!(
                                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch changed since snapshot"
                            );
                        }
                    }
                    None => {
                        let after = transition.after.as_ref().ok_or_else(|| {
                            anyhow::anyhow!("plot marker move branch transition has no target")
                        })?;
                        if load_row(conn, "plot_thread_branches", &after.id)?.is_some() {
                            anyhow::bail!(
                                "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch id already exists"
                            );
                        }
                    }
                }
            }

            replace_link_row(conn, &payload.marker_before, &payload.marker_after)?;
            for transition in &payload.branch_transitions {
                match (&transition.before, &transition.after) {
                    (None, Some(after)) => insert_or_validate_branch(conn, after)?,
                    (Some(before), Some(after)) => {
                        replace_branch_row(conn, before, after)?
                    }
                    (Some(before), None) => {
                        Database::execute_with_conn(
                            conn,
                            "DELETE FROM plot_thread_branches WHERE id = ? AND version = ?",
                            &[
                                Value::String(before.id.clone()),
                                Value::Number(before.version.into()),
                            ],
                            "run",
                        )?;
                        anyhow::ensure!(
                            conn.changes() == 1,
                            "PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED: branch version changed"
                        );
                    }
                    (None, None) => {
                        anyhow::bail!("plot marker move branch transition has no rows")
                    }
                }
            }
            record_plot_field_authority(
                conn,
                &payload.project_id,
                "plot-marker",
                &payload.marker_after.id,
                &[
                    "/threadId",
                    "/sceneId",
                    "/phaseType",
                    "/note",
                    "/sortOrder",
                    "/semanticKey",
                ],
            )?;
            for transition in &payload.branch_transitions {
                let branch = transition
                    .after
                    .as_ref()
                    .or(transition.before.as_ref())
                    .ok_or_else(|| anyhow::anyhow!("plot marker move branch transition has no row"))?;
                record_plot_field_authority(
                    conn,
                    &payload.project_id,
                    "plot-branch",
                    &branch.id,
                    &[
                        "/fromThreadId",
                        "/toThreadId",
                        "/atSceneId",
                        "/kind",
                        "/semanticKey",
                    ],
                )?;
            }
            reject_duplicate_branch_topology(
                conn,
                payload
                    .branch_transitions
                    .iter()
                    .filter_map(|transition| transition.after.clone()),
            )?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &payload.project_id,
                    operation: "plot.marker.move",
                    entity_type: "plot-marker",
                    entity_id: &payload.marker_after.id,
                    context: &write_context,
                    cause_kind: write_context.cause_kind,
                    origin: write_context.origin,
                    original_transaction_id: write_context.original_transaction_id.clone(),
                    events: move_marker_feed_events(&payload)?,
                },
            )?;
            Ok((
                payload.project_id.clone(),
                attach_maintenance_transaction_id(
                    move_marker_bundle_response(&request_id, &payload),
                    transaction_id,
                ),
            ))
        },
        |conn| move_marker_bundle_effect_present(conn, &request_id, &payload),
    )
    .map(|outcome| outcome.into_wire_value())
}

// ─────────────────────── history snapshot transactions ───────────────────────

fn plot_history_semantics(
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<String>,
) -> anyhow::Result<(
    NarrativeChangeCauseKind,
    NarrativeChangeOrigin,
    Option<String>,
)> {
    let cause_kind = match origin {
        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
        _ => NarrativeChangeCauseKind::Forward,
    };
    if cause_kind == NarrativeChangeCauseKind::Forward {
        anyhow::ensure!(
            original_transaction_id.is_none(),
            "plot history forward mutation cannot name an original transaction"
        );
    } else {
        anyhow::ensure!(
            original_transaction_id.is_some(),
            "plot undo/redo origin requires originalTransactionId"
        );
    }
    Ok((cause_kind, origin, original_transaction_id))
}

fn restore_snapshot_feed_events(
    payload: &PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut ordered = Vec::new();
    if let Some(thread) = &payload.thread {
        let after = serde_json::to_value(thread)?;
        ordered.push((
            0_u8,
            thread.id.clone(),
            plot_root_feed_event(
                &thread.id,
                "catalog",
                "restore",
                None,
                Some(&after),
                vec!["/".to_string()],
            )?,
        ));
    }
    for link in &payload.links {
        let after = serde_json::to_value(link)?;
        ordered.push((
            1_u8,
            link.id.clone(),
            plot_marker_feed_event(
                &link.id,
                "association",
                "restore",
                None,
                Some(&after),
                vec!["/".to_string()],
            )?,
        ));
    }
    for branch in &payload.branches {
        let after = serde_json::to_value(branch)?;
        ordered.push((
            2_u8,
            branch.id.clone(),
            plot_branch_feed_event(
                &branch.id,
                "association",
                "restore",
                None,
                Some(&after),
                vec!["/".to_string()],
            )?,
        ));
    }
    ordered.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));
    Ok(ordered.into_iter().map(|(_, _, event)| event).collect())
}

fn delete_snapshot_feed_events(
    payload: &PlotThreadDeleteSnapshotPayload,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut ordered = Vec::new();
    if let Some(thread) = &payload.thread {
        let before = serde_json::to_value(thread)?;
        ordered.push((
            0_u8,
            thread.id.clone(),
            plot_root_feed_event(
                &thread.id,
                "catalog",
                "delete",
                Some(&before),
                None,
                vec!["/".to_string()],
            )?,
        ));
    }
    for link in payload.link.iter().chain(&payload.links) {
        let before = serde_json::to_value(link)?;
        ordered.push((
            1_u8,
            link.id.clone(),
            plot_marker_feed_event(
                &link.id,
                "association",
                "delete",
                Some(&before),
                None,
                vec!["/".to_string()],
            )?,
        ));
    }
    for branch in &payload.branches {
        let before = serde_json::to_value(branch)?;
        ordered.push((
            2_u8,
            branch.id.clone(),
            plot_branch_feed_event(
                &branch.id,
                "association",
                "delete",
                Some(&before),
                None,
                vec!["/".to_string()],
            )?,
        ));
    }
    ordered.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));
    Ok(ordered.into_iter().map(|(_, _, event)| event).collect())
}

pub fn restore_snapshot(
    db: &Database,
    payload: PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<Value> {
    validate_restore_snapshot_shape(&payload)?;
    let request_id = payload.request_id.clone();
    let write_context = resolve_write_context(
        "plot.history.restore",
        &RendererWriteContext {
            request_id: request_id.clone(),
            session_id: payload.session_id.clone(),
            event_uid: payload.event_uid.clone(),
            origin: payload.origin,
            original_transaction_id: payload.original_transaction_id.clone(),
        },
    )?;
    let (cause_kind, origin, original_transaction_id) =
        plot_history_semantics(payload.origin, payload.original_transaction_id.clone())?;
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "thread": payload.thread,
        "links": payload.links,
        "branches": payload.branches,
        "origin": origin,
        "originalTransactionId": original_transaction_id,
    });
    let payload_hash = payload_fingerprint("plot_thread_restore_snapshot", &fingerprint_payload)?;
    let mut restored = payload;
    advance_restore_snapshot_versions(&mut restored)?;

    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_restore_snapshot",
            request_id: Some(request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_RESTORE_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            // The parent must exist before child membership checks. Any later
            // validation failure rolls this insert back with the ledger.
            if let Some(thread) = &restored.thread {
                insert_or_validate_thread(conn, thread)?;
            }
            validate_restore_snapshot_membership(conn, &restored)?;
            for link in &restored.links {
                insert_or_validate_link(conn, link)?;
            }
            for branch in &restored.branches {
                insert_or_validate_branch(conn, branch)?;
            }
            let entity_id = restored
                .thread
                .as_ref()
                .map(|thread| thread.id.as_str())
                .or_else(|| restored.links.first().map(|link| link.id.as_str()))
                .or_else(|| restored.branches.first().map(|branch| branch.id.as_str()))
                .ok_or_else(|| anyhow::anyhow!("plot restore snapshot has no entity"))?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &restored.project_id,
                    operation: "plot.history.restore",
                    entity_type: "plot-history",
                    entity_id,
                    context: &write_context,
                    cause_kind,
                    origin,
                    original_transaction_id: original_transaction_id.clone(),
                    events: restore_snapshot_feed_events(&restored)?,
                },
            )?;
            Ok((
                restored.project_id.clone(),
                attach_maintenance_transaction_id(
                    restore_snapshot_response(&request_id, &restored),
                    transaction_id,
                ),
            ))
        },
        |conn| load_exact_restore_snapshot(conn, &request_id, &restored),
    )
    .map(|outcome| outcome.into_wire_value())
}

fn expected_delete_branch_ids(
    conn: &Connection,
    project_id: &str,
    link_id: &str,
) -> anyhow::Result<Vec<String>> {
    let link = load_map(conn, "plot_thread_scene_links", link_id)?
        .ok_or_else(|| anyhow::anyhow!("plot delete snapshot link does not exist"))?;
    let thread_id = row_string(&link, "thread_id")
        .ok_or_else(|| anyhow::anyhow!("plot delete snapshot link has no thread"))?;
    let node_id = row_string(&link, "node_id")
        .ok_or_else(|| anyhow::anyhow!("plot delete snapshot link has no scene"))?;
    require_project_member(
        conn,
        "plot_threads",
        thread_id,
        project_id,
        "plot delete snapshot link thread",
    )?;
    require_project_scene(conn, node_id, project_id, "plot delete snapshot link scene")?;

    let other_links = Database::execute_with_conn(
        conn,
        "SELECT COUNT(*) AS count
           FROM plot_thread_scene_links
          WHERE id <> ? AND thread_id = ? AND node_id = ?",
        &[
            Value::String(link_id.to_string()),
            Value::String(thread_id.to_string()),
            Value::String(node_id.to_string()),
        ],
        "get",
    )?
    .first()
    .and_then(|row| row.get("count"))
    .and_then(Value::as_i64)
    .unwrap_or(0);
    if other_links > 0 {
        return Ok(Vec::new());
    }

    let rows = Database::execute_with_conn(
        conn,
        "SELECT id, project_id
           FROM plot_thread_branches
          WHERE to_thread_id = ? AND at_node_id = ?
          ORDER BY id",
        &[
            Value::String(thread_id.to_string()),
            Value::String(node_id.to_string()),
        ],
        "all",
    )?;
    let mut ids = Vec::with_capacity(rows.len());
    for row in rows {
        if row.get("project_id").and_then(Value::as_str) != Some(project_id) {
            anyhow::bail!("plot delete snapshot branch must belong to the snapshot project");
        }
        let id = row
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("plot delete snapshot branch has no id"))?;
        ids.push(id.to_string());
    }
    Ok(ids)
}

fn delete_snapshot_effect_present(
    conn: &Connection,
    request_id: &str,
    payload: &PlotThreadDeleteSnapshotPayload,
) -> anyhow::Result<Option<Value>> {
    if let Some(thread) = &payload.thread {
        if load_row(conn, "plot_threads", &thread.id)?.is_some() {
            return Ok(None);
        }
    }
    if let Some(link) = &payload.link {
        if load_row(conn, "plot_thread_scene_links", &link.id)?.is_some() {
            return Ok(None);
        }
    }
    for link in &payload.links {
        if load_row(conn, "plot_thread_scene_links", &link.id)?.is_some() {
            return Ok(None);
        }
    }
    for branch in &payload.branches {
        if load_row(conn, "plot_thread_branches", &branch.id)?.is_some() {
            return Ok(None);
        }
    }
    Ok(Some(json!({ "id": request_id, "deleted": true })))
}

fn load_sorted_ids(conn: &Connection, sql: &str, params: &[Value]) -> anyhow::Result<Vec<String>> {
    let rows = Database::execute_with_conn(conn, sql, params, "all")?;
    rows.into_iter()
        .map(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("plot snapshot dependency row has no id"))
        })
        .collect()
}

fn validate_thread_delete_snapshot(
    conn: &Connection,
    payload: &PlotThreadDeleteSnapshotPayload,
    thread: &PlotThreadSnapshotRow,
) -> anyhow::Result<()> {
    let current = load_map(conn, "plot_threads", &thread.id)?.ok_or_else(|| {
        anyhow::anyhow!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread no longer exists")
    })?;
    if !thread_row_matches(&current, thread) {
        anyhow::bail!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread changed since snapshot");
    }

    let expected_links = load_sorted_ids(
        conn,
        "SELECT id FROM plot_thread_scene_links WHERE thread_id = ? ORDER BY id",
        &[Value::String(thread.id.clone())],
    )?;
    let mut supplied_links = payload
        .links
        .iter()
        .map(|link| link.id.clone())
        .collect::<Vec<_>>();
    supplied_links.sort();
    if expected_links != supplied_links {
        anyhow::bail!(
            "PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread link set changed since snapshot"
        );
    }

    let expected_branches = load_sorted_ids(
        conn,
        "SELECT id FROM plot_thread_branches
          WHERE from_thread_id = ? OR to_thread_id = ?
          ORDER BY id",
        &[
            Value::String(thread.id.clone()),
            Value::String(thread.id.clone()),
        ],
    )?;
    let mut supplied_branches = payload
        .branches
        .iter()
        .map(|branch| branch.id.clone())
        .collect::<Vec<_>>();
    supplied_branches.sort();
    if expected_branches != supplied_branches {
        anyhow::bail!(
            "PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread branch set changed since snapshot"
        );
    }

    for link in &payload.links {
        let current = load_map(conn, "plot_thread_scene_links", &link.id)?.ok_or_else(|| {
            anyhow::anyhow!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: link no longer exists")
        })?;
        if !link_row_matches(&current, link) {
            anyhow::bail!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: link changed since snapshot");
        }
    }
    for branch in &payload.branches {
        let current = load_map(conn, "plot_thread_branches", &branch.id)?.ok_or_else(|| {
            anyhow::anyhow!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch no longer exists")
        })?;
        if !branch_row_matches(&current, branch) {
            anyhow::bail!("PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch changed since snapshot");
        }
    }
    Ok(())
}

pub fn delete_snapshot(
    db: &Database,
    payload: PlotThreadDeleteSnapshotPayload,
) -> anyhow::Result<Value> {
    if payload.request_id.is_empty() {
        anyhow::bail!("plot delete snapshot requestId must be non-empty");
    }
    if payload.project_id.is_empty() {
        anyhow::bail!("plot delete snapshot projectId must be non-empty");
    }
    anyhow::ensure!(
        payload.thread.is_some() ^ payload.link.is_some(),
        "plot delete snapshot must contain exactly one of thread or link"
    );
    if payload.link.is_some() && !payload.links.is_empty() {
        anyhow::bail!("plot marker delete snapshot cannot contain aggregate links");
    }
    let validation_snapshot = PlotThreadRestoreSnapshotPayload {
        request_id: payload.request_id.clone(),
        session_id: payload.session_id.clone(),
        event_uid: payload.event_uid.clone(),
        origin: payload.origin,
        original_transaction_id: payload.original_transaction_id.clone(),
        project_id: payload.project_id.clone(),
        thread: payload.thread.clone(),
        links: payload
            .link
            .clone()
            .into_iter()
            .chain(payload.links.clone())
            .collect(),
        branches: payload.branches.clone(),
    };
    validate_restore_snapshot_shape(&validation_snapshot)?;
    for link in &validation_snapshot.links {
        validate_phase(&link.phase_type)?;
    }
    for branch in &payload.branches {
        validate_branch_kind(&branch.kind)?;
        anyhow::ensure!(
            branch.from_thread_id != branch.to_thread_id,
            "plot thread branch cannot reference the same thread twice"
        );
    }

    let request_id = payload.request_id.clone();
    let write_context = resolve_write_context(
        "plot.history.delete",
        &RendererWriteContext {
            request_id: request_id.clone(),
            session_id: payload.session_id.clone(),
            event_uid: payload.event_uid.clone(),
            origin: payload.origin,
            original_transaction_id: payload.original_transaction_id.clone(),
        },
    )?;
    let (cause_kind, origin, original_transaction_id) =
        plot_history_semantics(payload.origin, payload.original_transaction_id.clone())?;
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "thread": payload.thread,
        "link": payload.link,
        "links": payload.links,
        "branches": payload.branches,
        "origin": origin,
        "originalTransactionId": original_transaction_id,
    });
    let payload_hash = payload_fingerprint("plot_thread_delete_snapshot", &fingerprint_payload)?;

    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_delete_snapshot",
            request_id: Some(request_id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_DELETE_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            require_project(conn, &payload.project_id)?;
            validate_restore_snapshot_membership(conn, &validation_snapshot)?;
            if let Some(thread) = &payload.thread {
                validate_thread_delete_snapshot(conn, &payload, thread)?;
                Database::execute_with_conn(
                    conn,
                    "DELETE FROM plot_threads WHERE id = ? AND version = ?",
                    &[
                        Value::String(thread.id.clone()),
                        Value::Number(thread.version.into()),
                    ],
                    "run",
                )?;
                anyhow::ensure!(
                    conn.changes() == 1,
                    "PLOT_THREAD_DELETE_PRECONDITION_FAILED: thread version changed"
                );
            } else if let Some(link) = &payload.link {
                let current = load_map(conn, "plot_thread_scene_links", &link.id)?
                    .ok_or_else(|| anyhow::anyhow!("plot delete snapshot link does not exist"))?;
                if !link_row_matches(&current, link) {
                    anyhow::bail!(
                        "PLOT_THREAD_DELETE_PRECONDITION_FAILED: link changed since snapshot"
                    );
                }
                let mut expected = expected_delete_branch_ids(conn, &payload.project_id, &link.id)?;
                let mut supplied = payload
                    .branches
                    .iter()
                    .map(|branch| branch.id.clone())
                    .collect::<Vec<_>>();
                expected.sort();
                supplied.sort();
                if supplied != expected {
                    anyhow::bail!(
                        "plot delete snapshot branch ids do not match the marker dependencies"
                    );
                }
                for branch in &payload.branches {
                    let current =
                        load_map(conn, "plot_thread_branches", &branch.id)?.ok_or_else(|| {
                            anyhow::anyhow!(
                                "PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch no longer exists"
                            )
                        })?;
                    if !branch_row_matches(&current, branch) {
                        anyhow::bail!(
                            "PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch changed since snapshot"
                        );
                    }
                    Database::execute_with_conn(
                        conn,
                        "DELETE FROM plot_thread_branches WHERE id = ? AND version = ?",
                        &[
                            Value::String(branch.id.clone()),
                            Value::Number(branch.version.into()),
                        ],
                        "run",
                    )?;
                    anyhow::ensure!(
                        conn.changes() == 1,
                        "PLOT_THREAD_DELETE_PRECONDITION_FAILED: branch version changed"
                    );
                }
                Database::execute_with_conn(
                    conn,
                    "DELETE FROM plot_thread_scene_links WHERE id = ? AND version = ?",
                    &[
                        Value::String(link.id.clone()),
                        Value::Number(link.version.into()),
                    ],
                    "run",
                )?;
                anyhow::ensure!(
                    conn.changes() == 1,
                    "PLOT_THREAD_DELETE_PRECONDITION_FAILED: link version changed"
                );
            }
            let entity_id = payload
                .thread
                .as_ref()
                .map(|thread| thread.id.as_str())
                .or_else(|| payload.link.as_ref().map(|link| link.id.as_str()))
                .ok_or_else(|| anyhow::anyhow!("plot delete snapshot has no entity"))?;
            let transaction_id = append_plot_feed(
                conn,
                PlotFeedAppend {
                    project_id: &payload.project_id,
                    operation: "plot.history.delete",
                    entity_type: "plot-history",
                    entity_id,
                    context: &write_context,
                    cause_kind,
                    origin,
                    original_transaction_id: original_transaction_id.clone(),
                    events: delete_snapshot_feed_events(&payload)?,
                },
            )?;
            Ok((
                payload.project_id.clone(),
                json!({
                    "id": request_id,
                    "deleted": true,
                    "maintenanceTransactionId": transaction_id,
                }),
            ))
        },
        |conn| delete_snapshot_effect_present(conn, &request_id, &payload),
    )
    .map(|outcome| outcome.into_wire_value())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.execute("INSERT INTO projects (id) VALUES ('p1')", &[], "run")
            .unwrap();
        db
    }

    fn test_identity(mut payload: Value) -> Value {
        let object = payload
            .as_object_mut()
            .expect("plot test payload must be an object");
        let context = RendererWriteContext::default();
        object.insert("projectId".to_string(), Value::String("p1".to_string()));
        object.insert("requestId".to_string(), Value::String(context.request_id));
        object.insert("sessionId".to_string(), Value::String(context.session_id));
        object.insert("eventUid".to_string(), Value::String(context.event_uid));
        object.insert(
            "origin".to_string(),
            serde_json::to_value(context.origin).expect("serialize origin"),
        );
        payload
    }

    fn delete_payload(id: &str, base_version: i64) -> PlotDeletePayload {
        PlotDeletePayload {
            id: id.to_string(),
            project_id: "p1".to_string(),
            base_version,
            context: RendererWriteContext::default(),
        }
    }

    fn renderer_context(request_id: &str) -> RendererWriteContext {
        RendererWriteContext {
            request_id: request_id.to_string(),
            session_id: "plot-test-session".to_string(),
            event_uid: format!("plot-test-event-{request_id}"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
        }
    }

    #[test]
    fn nullable_patches_preserve_omitted_null_and_value_states() {
        let omitted: PlotThreadPatch =
            serde_json::from_value(test_identity(json!({ "baseVersion": 0 }))).unwrap();
        assert_eq!(omitted.color, None);
        assert_eq!(omitted.description, None);

        let clear: PlotThreadPatch = serde_json::from_value(test_identity(json!({
            "color": null,
            "description": null,
            "baseVersion": 0
        })))
        .unwrap();
        assert_eq!(clear.color, Some(None));
        assert_eq!(clear.description, Some(None));

        let set: PlotThreadPatch = serde_json::from_value(test_identity(json!({
            "color": "#123456",
            "description": "detail",
            "baseVersion": 0
        })))
        .unwrap();
        assert_eq!(set.color, Some(Some("#123456".to_string())));
        assert_eq!(set.description, Some(Some("detail".to_string())));

        let omitted_link: PlotThreadLinkPatch =
            serde_json::from_value(test_identity(json!({ "baseVersion": 0 }))).unwrap();
        assert_eq!(omitted_link.note, None);
        assert_eq!(omitted_link.sort_order, None);

        let clear_link: PlotThreadLinkPatch = serde_json::from_value(test_identity(json!({
            "note": null,
            "sortOrder": null,
            "baseVersion": 0
        })))
        .unwrap();
        assert_eq!(clear_link.note, Some(None));
        assert_eq!(clear_link.sort_order, Some(None));
    }

    #[test]
    fn deserialized_explicit_null_clears_thread_and_link_columns() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene-nullable','p1','scene','Scene');
                 INSERT INTO plot_threads
                   (id, project_id, name, color, description, sort_order, version)
                   VALUES ('thread-nullable','p1','thread','#123456','detail','a0',0);
                 INSERT INTO plot_thread_scene_links
                   (id, thread_id, node_id, phase_type, note, sort_order,
                    semantic_key, version)
                   VALUES ('link-nullable','thread-nullable','scene-nullable','turn',
                           'marker note','marker-a0',
                           'thread-nullable|scene-nullable|turn',0);",
            )?;
            Ok(())
        })
        .unwrap();

        let thread_patch: PlotThreadPatch = serde_json::from_value(test_identity(json!({
            "color": null,
            "description": null,
            "baseVersion": 0
        })))
        .unwrap();
        let cleared_thread = update(&d, "thread-nullable".into(), thread_patch).unwrap();
        assert_eq!(cleared_thread["color"], Value::Null);
        assert_eq!(cleared_thread["description"], Value::Null);
        assert_eq!(cleared_thread["version"], 1);

        let omitted_thread_patch: PlotThreadPatch =
            serde_json::from_value(test_identity(json!({ "baseVersion": 1 }))).unwrap();
        let unchanged_thread = update(&d, "thread-nullable".into(), omitted_thread_patch).unwrap();
        assert_eq!(unchanged_thread["version"], 1);

        let link_patch: PlotThreadLinkPatch = serde_json::from_value(test_identity(json!({
            "note": null,
            "sortOrder": null,
            "baseVersion": 0
        })))
        .unwrap();
        let cleared_link = link_update(&d, "link-nullable".into(), link_patch).unwrap();
        assert_eq!(cleared_link["note"], Value::Null);
        assert_eq!(cleared_link["sort_order"], Value::Null);
        assert_eq!(cleared_link["version"], 1);

        let omitted_link_patch: PlotThreadLinkPatch =
            serde_json::from_value(test_identity(json!({ "baseVersion": 1 }))).unwrap();
        let unchanged_link = link_update(&d, "link-nullable".into(), omitted_link_patch).unwrap();
        assert_eq!(unchanged_link["version"], 1);
    }

    #[test]
    fn create_then_list_roundtrips() {
        let d = db();
        let created = create(
            &d,
            PlotThreadCreatePayload {
                context: RendererWriteContext::default(),
                id: None,
                project_id: "p1".into(),
                name: "復讐の糸".into(),
                color: Some("#c33".into()),
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        assert!(created.is_object());
        let rows = list(&d, "p1".into()).unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn create_reuses_domain_id_for_an_identical_retry() {
        let d = db();
        let payload = || PlotThreadCreatePayload {
            context: renderer_context("request-1"),
            id: Some("request-1".into()),
            project_id: "p1".into(),
            name: "retry-safe".into(),
            color: Some("#123".into()),
            description: Some("same logical request".into()),
            sort_order: "a0".into(),
        };
        let first = create(&d, payload()).unwrap();
        let mut retry_payload = payload();
        retry_payload.context.session_id = "plot-retry-session".into();
        retry_payload.context.event_uid = "plot-retry-event".into();
        let retried = create(&d, retry_payload).unwrap();

        assert_eq!(first.get("id"), retried.get("id"));
        assert_eq!(retried["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(retried["__idempotency"]["entityPresent"], Value::Bool(true));
        let event_count: i64 = d
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM change_events WHERE project_id = 'p1' AND domain = 'plot'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count canonical plot create events");
        let feed_count: i64 = d
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = 'p1' AND source_domain = 'plot.thread.create'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count plot maintenance transactions");
        assert_eq!((event_count, feed_count), (1, 1));
        delete(&d, delete_payload("request-1", 0)).expect("delete thread");
        let deleted_retry = create(&d, payload()).expect("retry after delete");
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );
        assert!(list(&d, "p1".into()).unwrap().is_empty());
    }

    #[test]
    fn regular_thread_and_link_mutations_reject_stale_versions() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene','p1','scene','Scene');
                 INSERT INTO plot_threads (id, project_id, name, sort_order, version)
                   VALUES ('thread','p1','original','a0',0);
                 INSERT INTO plot_thread_scene_links
                   (id, thread_id, node_id, phase_type, semantic_key, version)
                   VALUES ('link','thread','scene','turn','thread|scene|turn',0);",
            )?;
            Ok(())
        })
        .unwrap();

        let updated_thread = update(
            &d,
            "thread".into(),
            PlotThreadPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                name: Some("winner".into()),
                color: None,
                description: None,
                sort_order: None,
                base_version: 0,
            },
        )
        .expect("current thread update");
        assert_eq!(updated_thread["version"], 1);
        let stale_thread = update(
            &d,
            "thread".into(),
            PlotThreadPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                name: Some("stale".into()),
                color: None,
                description: None,
                sort_order: None,
                base_version: 0,
            },
        )
        .expect_err("stale thread update");
        assert!(stale_thread
            .to_string()
            .contains("PLOT_THREAD_VERSION_MISMATCH"));
        assert!(delete(&d, delete_payload("thread", 0)).is_err());

        let updated_link = link_update(
            &d,
            "link".into(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: None,
                phase_type: None,
                note: Some(Some("winner".into())),
                sort_order: None,
                base_version: 0,
            },
        )
        .expect("current link update");
        assert_eq!(updated_link["version"], 1);
        let stale_link = link_update(
            &d,
            "link".into(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: None,
                phase_type: None,
                note: Some(Some("stale".into())),
                sort_order: None,
                base_version: 0,
            },
        )
        .expect_err("stale link update");
        assert!(stale_link
            .to_string()
            .contains("PLOT_THREAD_LINK_VERSION_MISMATCH"));
        assert!(link_delete(&d, delete_payload("link", 0)).is_err());

        let rows = d
            .execute(
                "SELECT
                   (SELECT name || ':' || version FROM plot_threads WHERE id = 'thread') AS thread,
                   (SELECT note || ':' || version FROM plot_thread_scene_links WHERE id = 'link') AS link",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["thread"].as_str(), Some("winner:1"));
        assert_eq!(rows[0]["link"].as_str(), Some("winner:1"));

        link_delete(&d, delete_payload("link", 1)).expect("current link delete");
        delete(&d, delete_payload("thread", 1)).expect("current thread delete");
        assert!(link_update(
            &d,
            "link".into(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: None,
                phase_type: None,
                note: Some(Some("missing".into())),
                sort_order: None,
                base_version: 1,
            },
        )
        .is_err());
        assert!(update(
            &d,
            "thread".into(),
            PlotThreadPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                name: Some("missing".into()),
                color: None,
                description: None,
                sort_order: None,
                base_version: 1,
            },
        )
        .is_err());
    }

    #[test]
    fn create_rejects_domain_id_reuse_with_different_input() {
        let d = db();
        create(
            &d,
            PlotThreadCreatePayload {
                context: RendererWriteContext::default(),
                id: Some("request-1".into()),
                project_id: "p1".into(),
                name: "first".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        let error = create(
            &d,
            PlotThreadCreatePayload {
                context: RendererWriteContext::default(),
                id: Some("request-1".into()),
                project_id: "p1".into(),
                name: "different".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("PLOT_THREAD_IDEMPOTENCY_CONFLICT"));
        assert_eq!(list(&d, "p1".into()).unwrap().len(), 1);
    }

    #[test]
    fn link_create_rejects_invalid_phase() {
        let d = db();
        create(
            &d,
            PlotThreadCreatePayload {
                context: RendererWriteContext::default(),
                id: None,
                project_id: "p1".into(),
                name: "t".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();
        // thread id を取得
        let threads = list(&d, "p1".into()).unwrap();
        let tid = threads[0]
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        let bad = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                id: None,
                thread_id: tid.clone(),
                node_id: "s1".into(),
                phase_type: "BOGUS".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(bad.is_err(), "invalid phase_type must be rejected");

        let ok = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                id: None,
                thread_id: tid,
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(ok.is_ok(), "valid phase_type must insert");
    }

    #[test]
    fn link_create_reuses_domain_id_only_for_an_identical_retry() {
        let d = db();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('t1','p1','t','a0')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();

        let payload = || PlotThreadLinkCreatePayload {
            context: renderer_context("link-request-1"),
            project_id: "p1".into(),
            id: Some("link-request-1".into()),
            thread_id: "t1".into(),
            node_id: "s1".into(),
            phase_type: "introduce".into(),
            note: Some("same".into()),
            sort_order: None,
        };
        let first = link_create(&d, payload()).unwrap();
        let retried = link_create(&d, payload()).unwrap();
        assert_eq!(first.get("id"), retried.get("id"));
        assert_eq!(retried["__idempotency"]["entityPresent"], Value::Bool(true));
        link_delete(&d, delete_payload("link-request-1", 0)).expect("delete link");
        let deleted_retry = link_create(&d, payload()).expect("retry after link delete");
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );

        let conflict = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: renderer_context("link-request-1"),
                project_id: "p1".into(),
                id: Some("link-request-1".into()),
                thread_id: "t1".into(),
                node_id: "s1".into(),
                phase_type: "develop".into(),
                note: Some("different".into()),
                sort_order: None,
            },
        )
        .unwrap_err();
        assert!(conflict
            .to_string()
            .contains("PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT"));
        assert!(list_links(&d, "p1".into()).unwrap().is_empty());
    }

    #[test]
    fn link_create_rejects_cross_project() {
        let d = db();
        // p1 にスレッド、p2 にシーン。
        d.execute("INSERT INTO projects (id) VALUES ('p2')", &[], "run")
            .unwrap();
        create(
            &d,
            PlotThreadCreatePayload {
                context: RendererWriteContext::default(),
                id: None,
                project_id: "p1".into(),
                name: "t".into(),
                color: None,
                description: None,
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s2','p2','scene','S2')",
            &[],
            "run",
        )
        .unwrap();
        let tid = list(&d, "p1".into()).unwrap()[0]
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        // p1 のスレッド × p2 のシーンは拒否される。
        let cross = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                id: None,
                thread_id: tid,
                node_id: "s2".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        );
        assert!(cross.is_err(), "cross-project link must be rejected");
    }

    #[test]
    fn link_update_moves_thread_within_project_and_rejects_cross_project() {
        let d = db();
        d.execute("INSERT INTO projects (id) VALUES ('p2')", &[], "run")
            .unwrap();
        for (id, so) in [("a", "a0"), ("b", "a1")] {
            d.execute(
                "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES (?, 'p1', ?, ?)",
                &[
                    Value::String(id.into()),
                    Value::String(id.into()),
                    Value::String(so.into()),
                ],
                "run",
            )
            .unwrap();
        }
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1','p1','scene','S1')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s2','p2','scene','S2')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('c','p2','c','a0')",
            &[],
            "run",
        )
        .unwrap();
        let link = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                id: None,
                thread_id: "a".into(),
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: None,
                sort_order: None,
            },
        )
        .unwrap();
        let lid = link
            .as_object()
            .and_then(|o| o.get("id"))
            .and_then(|v| v.as_str())
            .unwrap()
            .to_string();

        // 同 project の thread b へ移動 → OK & 反映される。
        let ok = link_update(
            &d,
            lid.clone(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: Some("b".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
                base_version: 0,
            },
        )
        .unwrap();
        assert_eq!(
            ok.as_object()
                .and_then(|o| o.get("thread_id"))
                .and_then(|v| v.as_str()),
            Some("b")
        );
        assert_eq!(ok["version"].as_i64(), Some(1));
        assert_eq!(ok["semantic_key"].as_str(), Some("b|s1|introduce"));

        // node-only moves are subject to the same project guard.
        let cross_node = link_update(
            &d,
            lid.clone(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: Some("s2".into()),
                phase_type: None,
                note: None,
                sort_order: None,
                base_version: 1,
            },
        );
        assert!(
            cross_node.is_err(),
            "cross-project scene move must be rejected"
        );

        let cross_both = link_update(
            &d,
            lid.clone(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: Some("c".into()),
                node_id: Some("s2".into()),
                phase_type: None,
                note: None,
                sort_order: None,
                base_version: 1,
            },
        );
        assert!(
            cross_both.is_err(),
            "moving both endpoints must not transfer link ownership"
        );

        // 別 project の thread c へ移動 → 拒否。
        let cross = link_update(
            &d,
            lid.clone(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: Some("c".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
                base_version: 1,
            },
        );
        assert!(cross.is_err(), "cross-project thread move must be rejected");
        let stored = d
            .execute(
                "SELECT thread_id, node_id, semantic_key, version
                   FROM plot_thread_scene_links WHERE id = ?",
                &[Value::String(lid)],
                "get",
            )
            .unwrap();
        assert_eq!(stored[0]["thread_id"].as_str(), Some("b"));
        assert_eq!(stored[0]["node_id"].as_str(), Some("s1"));
        assert_eq!(stored[0]["semantic_key"].as_str(), Some("b|s1|introduce"));
        assert_eq!(stored[0]["version"].as_i64(), Some(1));
    }

    #[test]
    fn link_update_preserves_legacy_duplicate_semantic_key_suffix() {
        let d = db();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES ('thread','p1','thread','a0')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO plot_thread_scene_links
                (id, thread_id, node_id, phase_type, semantic_key, version)
             VALUES
                ('primary','thread','scene','introduce','thread|scene|introduce',0),
                ('legacy','thread','scene','introduce','thread|scene|introduce#dup:legacy',0)",
            &[],
            "run",
        )
        .unwrap();

        let updated = link_update(
            &d,
            "legacy".into(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: None,
                phase_type: None,
                note: Some(Some("kept".into())),
                sort_order: None,
                base_version: 0,
            },
        )
        .expect("legacy duplicate remains writable");
        assert_eq!(
            updated["semantic_key"].as_str(),
            Some("thread|scene|introduce#dup:legacy")
        );
        assert_eq!(updated["version"].as_i64(), Some(1));
        assert_eq!(updated["note"].as_str(), Some("kept"));
    }

    #[test]
    fn branch_create_is_durable_after_delete_and_rejects_payload_reuse() {
        let d = db();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES ('from','p1','from','a0'), ('to','p1','to','a1')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        let payload = || PlotThreadBranchCreatePayload {
            context: renderer_context("branch-request-1"),
            id: Some("branch-request-1".into()),
            project_id: "p1".into(),
            from_thread_id: "from".into(),
            to_thread_id: "to".into(),
            at_node_id: "scene".into(),
            kind: "branch".into(),
        };
        let first = branch_create(&d, payload()).expect("first branch");
        let replay = branch_create(&d, payload()).expect("branch replay");
        assert_eq!(replay["id"], first["id"]);
        assert_eq!(replay["__idempotency"]["entityPresent"], Value::Bool(true));

        d.execute(
            "DELETE FROM plot_thread_branches WHERE id = 'branch-request-1'",
            &[],
            "run",
        )
        .unwrap();
        let deleted_replay = branch_create(&d, payload()).expect("replay after delete");
        assert_eq!(
            deleted_replay["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );
        let count = d
            .execute("SELECT count(*) AS n FROM plot_thread_branches", &[], "get")
            .unwrap();
        assert_eq!(count[0]["n"].as_i64(), Some(0));

        let conflict = branch_create(
            &d,
            PlotThreadBranchCreatePayload {
                kind: "merge".into(),
                ..payload()
            },
        )
        .expect_err("different branch payload");
        assert!(conflict
            .to_string()
            .contains("PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT"));
    }

    #[test]
    fn branch_create_enforces_cross_project_ownership_in_native_transaction() {
        let d = db();
        d.execute("INSERT INTO projects (id) VALUES ('p2')", &[], "run")
            .unwrap();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES ('p1-thread','p1','p1','a0'), ('p2-thread','p2','p2','a0')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('p1-scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        let error = branch_create(
            &d,
            PlotThreadBranchCreatePayload {
                context: RendererWriteContext::default(),
                id: Some("cross-project-branch".into()),
                project_id: "p1".into(),
                from_thread_id: "p1-thread".into(),
                to_thread_id: "p2-thread".into(),
                at_node_id: "p1-scene".into(),
                kind: "branch".into(),
            },
        )
        .expect_err("cross-project branch");
        assert!(error.to_string().contains("same project"));
    }

    #[test]
    fn plot_topology_rejects_non_scene_nodes_without_mutation() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES
                     ('scene','p1','scene','Scene'),
                     ('folder','p1','folder','Folder');
                 INSERT INTO plot_threads (id, project_id, name, sort_order)
                   VALUES
                     ('source','p1','source','a0'),
                     ('target','p1','target','a1');",
            )?;
            Ok(())
        })
        .unwrap();

        assert!(link_create(
            &d,
            PlotThreadLinkCreatePayload {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                id: Some("folder-link".into()),
                thread_id: "target".into(),
                node_id: "folder".into(),
                phase_type: "turn".into(),
                note: None,
                sort_order: None,
            },
        )
        .is_err());
        assert!(branch_create(
            &d,
            PlotThreadBranchCreatePayload {
                context: RendererWriteContext::default(),
                id: Some("folder-branch".into()),
                project_id: "p1".into(),
                from_thread_id: "source".into(),
                to_thread_id: "target".into(),
                at_node_id: "folder".into(),
                kind: "branch".into(),
            },
        )
        .is_err());

        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO plot_thread_scene_links
                   (id, thread_id, node_id, phase_type, semantic_key, version)
                 VALUES ('link','target','scene','turn','target|scene|turn',0);
                 INSERT INTO plot_thread_branches
                   (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                    semantic_key, version)
                 VALUES ('branch','p1','source','target','scene','branch',
                         'source|target|scene|branch',0);",
            )?;
            Ok(())
        })
        .unwrap();
        assert!(link_update(
            &d,
            "link".into(),
            PlotThreadLinkPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                thread_id: None,
                node_id: Some("folder".into()),
                phase_type: None,
                note: None,
                sort_order: None,
                base_version: 0,
            },
        )
        .is_err());
        assert!(branch_update(
            &d,
            "branch".into(),
            PlotThreadBranchPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                from_thread_id: None,
                to_thread_id: None,
                at_node_id: Some("folder".into()),
                base_version: 0,
            },
        )
        .is_err());

        let mut restored_thread = thread_snapshot("restored");
        restored_thread.start_node_id = Some("folder".into());
        restored_thread.end_node_id = None;
        assert!(restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "restore-folder-boundary".into(),
                project_id: "p1".into(),
                thread: Some(restored_thread),
                links: vec![],
                branches: vec![],
            },
        )
        .is_err());

        let mut marker_after = link_snapshot("link", "target");
        marker_after.node_id = "folder".into();
        marker_after.updated_at = "2026-01-03T01:00:00.000Z".into();
        assert!(move_marker_bundle(
            &d,
            PlotThreadMoveMarkerBundlePayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                request_id: "move-marker-to-folder".into(),
                project_id: "p1".into(),
                marker_before: link_snapshot("link", "target"),
                marker_after,
                branch_transitions: vec![],
            },
        )
        .is_err());

        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_thread_scene_links WHERE id = 'folder-link') AS folder_links,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'folder-branch') AS folder_branches,
                   (SELECT node_id || ':' || version FROM plot_thread_scene_links WHERE id = 'link') AS link_state,
                   (SELECT at_node_id || ':' || version FROM plot_thread_branches WHERE id = 'branch') AS branch_state,
                   (SELECT COUNT(*) FROM plot_threads WHERE id = 'restored') AS restored_threads,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE request_id IN ('restore-folder-boundary','move-marker-to-folder')) AS ledgers",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["folder_links"].as_i64(), Some(0));
        assert_eq!(rows[0]["folder_branches"].as_i64(), Some(0));
        assert_eq!(rows[0]["link_state"].as_str(), Some("scene:0"));
        assert_eq!(rows[0]["branch_state"].as_str(), Some("scene:0"));
        assert_eq!(rows[0]["restored_threads"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledgers"].as_i64(), Some(0));
    }

    #[test]
    fn branch_update_is_atomic_versioned_and_preserves_legacy_suffixes() {
        let d = db();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES
                ('from','p1','from','a0'),
                ('to','p1','to','a1'),
                ('alternate','p1','alternate','a2')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        let created = branch_create(
            &d,
            PlotThreadBranchCreatePayload {
                context: RendererWriteContext::default(),
                id: Some("branch".into()),
                project_id: "p1".into(),
                from_thread_id: "from".into(),
                to_thread_id: "to".into(),
                at_node_id: "scene".into(),
                kind: "branch".into(),
            },
        )
        .unwrap();
        assert_eq!(created["version"].as_i64(), Some(0));

        let updated = branch_update(
            &d,
            "branch".into(),
            PlotThreadBranchPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                from_thread_id: Some("alternate".into()),
                to_thread_id: None,
                at_node_id: None,
                base_version: 0,
            },
        )
        .unwrap();
        assert_eq!(updated["version"].as_i64(), Some(1));
        assert_eq!(
            updated["semantic_key"].as_str(),
            Some("alternate|to|scene|branch")
        );

        let stale = branch_update(
            &d,
            "branch".into(),
            PlotThreadBranchPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                from_thread_id: None,
                to_thread_id: Some("from".into()),
                at_node_id: None,
                base_version: 0,
            },
        )
        .expect_err("stale branch patch");
        assert!(stale
            .to_string()
            .contains("PLOT_THREAD_BRANCH_VERSION_MISMATCH"));
        let stored = d
            .execute(
                "SELECT from_thread_id, to_thread_id, semantic_key, version
                   FROM plot_thread_branches WHERE id = 'branch'",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(stored[0]["from_thread_id"].as_str(), Some("alternate"));
        assert_eq!(stored[0]["to_thread_id"].as_str(), Some("to"));
        assert_eq!(stored[0]["version"].as_i64(), Some(1));
        let stale_delete = branch_delete(&d, delete_payload("branch", 0))
            .expect_err("stale branch delete must not remove the row");
        assert!(stale_delete
            .to_string()
            .contains("PLOT_THREAD_BRANCH_VERSION_MISMATCH"));
        branch_delete(&d, delete_payload("branch", 1)).expect("matching branch delete");
        assert!(d
            .execute(
                "SELECT id FROM plot_thread_branches WHERE id = 'branch'",
                &[],
                "get",
            )
            .unwrap()
            .is_empty());

        d.execute(
            "INSERT INTO plot_thread_branches
                (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                 semantic_key, version)
             VALUES
                ('primary','p1','from','to','scene','branch',
                 'from|to|scene|branch',0),
                ('legacy','p1','from','to','scene','branch',
                 'from|to|scene|branch#dup:legacy',0)",
            &[],
            "run",
        )
        .unwrap();
        let legacy = branch_update(
            &d,
            "legacy".into(),
            PlotThreadBranchPatch {
                context: RendererWriteContext::default(),
                project_id: "p1".into(),
                from_thread_id: Some("from".into()),
                to_thread_id: None,
                at_node_id: None,
                base_version: 0,
            },
        )
        .expect("legacy duplicate remains writable");
        assert_eq!(
            legacy["semantic_key"].as_str(),
            Some("from|to|scene|branch#dup:legacy")
        );
        assert_eq!(legacy["version"].as_i64(), Some(1));
    }

    fn thread_snapshot(id: &str) -> PlotThreadSnapshotRow {
        PlotThreadSnapshotRow {
            id: id.into(),
            project_id: "p1".into(),
            name: "restored".into(),
            color: Some("#123456".into()),
            description: Some("snapshot".into()),
            sort_order: "a1".into(),
            start_node_id: Some("scene".into()),
            end_node_id: Some("scene".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-02T00:00:00.000Z".into(),
            version: 0,
        }
    }

    fn link_snapshot(id: &str, thread_id: &str) -> PlotThreadLinkSnapshotRow {
        PlotThreadLinkSnapshotRow {
            id: id.into(),
            thread_id: thread_id.into(),
            node_id: "scene".into(),
            phase_type: "turn".into(),
            note: Some("marker".into()),
            sort_order: Some("a0".into()),
            semantic_key: None,
            version: 0,
            created_at: "2026-01-01T01:00:00.000Z".into(),
            updated_at: "2026-01-02T01:00:00.000Z".into(),
        }
    }

    fn branch_snapshot(
        id: &str,
        from_thread_id: &str,
        to_thread_id: &str,
    ) -> PlotThreadBranchSnapshotRow {
        PlotThreadBranchSnapshotRow {
            id: id.into(),
            project_id: "p1".into(),
            from_thread_id: from_thread_id.into(),
            to_thread_id: to_thread_id.into(),
            at_node_id: "scene".into(),
            kind: "branch".into(),
            semantic_key: None,
            version: 0,
            created_at: "2026-01-01T02:00:00.000Z".into(),
            updated_at: "2026-01-02T02:00:00.000Z".into(),
        }
    }

    #[test]
    fn child_feed_uses_typed_identity_and_preserves_state_continuity() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene','p1','scene','Scene'),
                          ('scene-2','p1','scene','Scene 2');
                 INSERT INTO plot_threads (id, project_id, name, sort_order)
                   VALUES ('thread-a','p1','A','a0'),
                          ('thread-b','p1','B','a1');",
            )?;
            Ok(())
        })
        .expect("seed plot child Feed fixture");

        link_create(
            &d,
            PlotThreadLinkCreatePayload {
                id: Some("marker-feed".to_string()),
                context: renderer_context("marker-feed-create"),
                project_id: "p1".to_string(),
                thread_id: "thread-a".to_string(),
                node_id: "scene".to_string(),
                phase_type: "turn".to_string(),
                note: None,
                sort_order: Some("a0".to_string()),
            },
        )
        .expect("create marker");
        link_update(
            &d,
            "marker-feed".to_string(),
            PlotThreadLinkPatch {
                context: renderer_context("marker-feed-update"),
                project_id: "p1".to_string(),
                thread_id: None,
                node_id: Some("scene-2".to_string()),
                phase_type: None,
                note: Some(Some("moved".to_string())),
                sort_order: None,
                base_version: 0,
            },
        )
        .expect("update marker");
        link_delete(
            &d,
            PlotDeletePayload {
                id: "marker-feed".to_string(),
                context: renderer_context("marker-feed-delete"),
                project_id: "p1".to_string(),
                base_version: 1,
            },
        )
        .expect("delete marker");

        branch_create(
            &d,
            PlotThreadBranchCreatePayload {
                id: Some("branch-feed".to_string()),
                context: renderer_context("branch-feed-create"),
                project_id: "p1".to_string(),
                from_thread_id: "thread-a".to_string(),
                to_thread_id: "thread-b".to_string(),
                at_node_id: "scene".to_string(),
                kind: "branch".to_string(),
            },
        )
        .expect("create branch");
        branch_update(
            &d,
            "branch-feed".to_string(),
            PlotThreadBranchPatch {
                context: renderer_context("branch-feed-update"),
                project_id: "p1".to_string(),
                from_thread_id: None,
                to_thread_id: None,
                at_node_id: Some("scene-2".to_string()),
                base_version: 0,
            },
        )
        .expect("update branch");
        branch_delete(
            &d,
            PlotDeletePayload {
                id: "branch-feed".to_string(),
                context: renderer_context("branch-feed-delete"),
                project_id: "p1".to_string(),
                base_version: 1,
            },
        )
        .expect("delete branch");

        for (object_kind, object_id, expected_paths) in [
            (
                "plot-marker",
                "marker-feed",
                vec![vec!["/"], vec!["/note", "/sceneId"], vec!["/"]],
            ),
            (
                "plot-branch",
                "branch-feed",
                vec![vec!["/"], vec!["/atSceneId"], vec!["/"]],
            ),
        ] {
            let identity_path = if object_kind == "plot-marker" {
                "$.markerId"
            } else {
                "$.branchId"
            };
            let expected_key = if object_kind == "plot-marker" {
                json!({ "kind": object_kind, "markerId": object_id })
            } else {
                json!({ "kind": object_kind, "branchId": object_id })
            };
            d.with_conn(|conn| {
                let rows = conn
                    .prepare(
                        "SELECT event.object_key_json, event.mutation_kind,
                                event.before_digest, event.after_digest,
                                event.changed_paths_json
                           FROM narrative_change_events event
                           JOIN narrative_change_transactions transaction_row
                             ON transaction_row.id = event.transaction_id
                            AND transaction_row.project_id = event.project_id
                          WHERE event.project_id = 'p1'
                            AND json_extract(event.object_key_json, ?1) = ?2
                          ORDER BY event.canonical_sequence, event.event_ordinal",
                    )?
                    .query_map(rusqlite::params![identity_path, object_id], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                        ))
                    })?
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(rows.len(), 3);
                assert!(rows.iter().all(|row| {
                    serde_json::from_str::<Value>(&row.0).ok() == Some(expected_key.clone())
                }));
                assert_eq!(
                    rows.iter().map(|row| row.1.as_str()).collect::<Vec<_>>(),
                    vec!["create", "update", "delete"]
                );
                assert_eq!(rows[0].3, rows[1].2, "create -> update must be continuous");
                assert_eq!(rows[1].3, rows[2].2, "update -> delete must be continuous");
                assert_eq!(rows[0].2, None);
                assert_eq!(rows[2].3, None);
                let paths = rows
                    .iter()
                    .map(|row| serde_json::from_str::<Vec<String>>(&row.4))
                    .collect::<Result<Vec<_>, _>>()?;
                assert_eq!(paths, expected_paths);
                Ok(())
            })
            .expect("inspect typed plot child Feed continuity");
        }
    }

    #[test]
    fn history_feed_orders_root_then_markers_then_branches_by_entity_id() {
        let payload = PlotThreadRestoreSnapshotPayload {
            request_id: "restore-order".to_string(),
            session_id: "plot-test-session".to_string(),
            event_uid: "restore-order-event".to_string(),
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            project_id: "p1".to_string(),
            thread: Some(thread_snapshot("thread-z")),
            links: vec![
                link_snapshot("marker-z", "thread-z"),
                link_snapshot("marker-a", "thread-z"),
            ],
            branches: vec![
                branch_snapshot("branch-z", "thread-a", "thread-z"),
                branch_snapshot("branch-a", "thread-a", "thread-z"),
            ],
        };
        let events = restore_snapshot_feed_events(&payload).expect("build ordered Feed events");
        assert_eq!(
            events
                .into_iter()
                .map(|event| event.object_key)
                .collect::<Vec<_>>(),
            vec![
                json!({ "kind": "plot-thread", "threadId": "thread-z" }),
                json!({ "kind": "plot-marker", "markerId": "marker-a" }),
                json!({ "kind": "plot-marker", "markerId": "marker-z" }),
                json!({ "kind": "plot-branch", "branchId": "branch-a" }),
                json!({ "kind": "plot-branch", "branchId": "branch-z" }),
            ]
        );
    }

    #[test]
    fn restore_snapshot_is_atomic_replay_safe_and_does_not_resurrect_after_delete() {
        let d = db();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES ('source','p1','source','a0')",
            &[],
            "run",
        )
        .unwrap();
        let payload = || PlotThreadRestoreSnapshotPayload {
            session_id: "plot-test-session".to_string(),
            event_uid: "plot-test-event-restore-request-1".to_string(),
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            request_id: "restore-request-1".into(),
            project_id: "p1".into(),
            thread: Some(thread_snapshot("target")),
            links: vec![link_snapshot("link", "target")],
            branches: vec![branch_snapshot("branch", "source", "target")],
        };

        let first = restore_snapshot(&d, payload()).expect("restore snapshot");
        assert_eq!(first["thread"]["id"], Value::String("target".into()));
        assert_eq!(first["links"][0]["id"], Value::String("link".into()));
        assert_eq!(first["branches"][0]["id"], Value::String("branch".into()));
        let replay = restore_snapshot(&d, payload()).expect("exact replay");
        assert_eq!(replay["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(replay["__idempotency"]["entityPresent"], Value::Bool(true));

        d.execute("DELETE FROM plot_threads WHERE id = 'target'", &[], "run")
            .unwrap();
        let deleted_replay = restore_snapshot(&d, payload()).expect("replay after cascade delete");
        assert_eq!(
            deleted_replay["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );
        assert!(d
            .execute(
                "SELECT id FROM plot_threads WHERE id = 'target'",
                &[],
                "get",
            )
            .unwrap()
            .is_empty());
    }

    #[test]
    fn restore_snapshot_preserves_multiple_semantic_keys_and_advances_versions() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                 VALUES ('scene','p1','scene','Scene');
                 INSERT INTO plot_threads (id, project_id, name, sort_order)
                 VALUES ('source','p1','source','a0');",
            )?;
            Ok(())
        })
        .unwrap();
        let mut thread = thread_snapshot("target");
        thread.version = 3;
        let mut primary_link = link_snapshot("link-primary", "target");
        primary_link.semantic_key = Some("target|scene|turn".into());
        primary_link.version = 4;
        let mut duplicate_link = link_snapshot("link-legacy", "target");
        duplicate_link.semantic_key = Some("target|scene|turn#dup:link-legacy".into());
        duplicate_link.version = 5;
        let mut primary_branch = branch_snapshot("branch-primary", "source", "target");
        primary_branch.semantic_key = Some("source|target|scene|branch".into());
        primary_branch.version = 6;
        let mut duplicate_branch = branch_snapshot("branch-legacy", "source", "target");
        duplicate_branch.semantic_key = Some("source|target|scene|branch#dup:branch-legacy".into());
        duplicate_branch.version = 7;

        restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "restore-multiple-semantic-keys".into(),
                project_id: "p1".into(),
                thread: Some(thread),
                links: vec![primary_link, duplicate_link],
                branches: vec![primary_branch, duplicate_branch],
            },
        )
        .expect("restore duplicate legacy topology rows");

        let rows = d
            .execute(
                "SELECT
                   (SELECT version FROM plot_threads WHERE id = 'target') AS thread_version,
                   (SELECT group_concat(semantic_key || ':' || version, ',')
                      FROM (SELECT semantic_key, version FROM plot_thread_scene_links
                             ORDER BY semantic_key)) AS link_keys,
                   (SELECT group_concat(semantic_key || ':' || version, ',')
                      FROM (SELECT semantic_key, version FROM plot_thread_branches
                             ORDER BY semantic_key)) AS branch_keys",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["thread_version"].as_i64(), Some(4));
        assert_eq!(
            rows[0]["link_keys"].as_str(),
            Some("target|scene|turn:5,target|scene|turn#dup:link-legacy:6")
        );
        assert_eq!(
            rows[0]["branch_keys"].as_str(),
            Some("source|target|scene|branch:7,source|target|scene|branch#dup:branch-legacy:8")
        );
    }

    #[test]
    fn thread_snapshot_delete_is_exact_and_restore_versions_prevent_aba() {
        let d = db();
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene','p1','scene','Scene');
                 INSERT INTO plot_threads (id, project_id, name, sort_order)
                   VALUES ('source','p1','source','a0');",
            )?;
            Ok(())
        })
        .unwrap();

        let restored_v1 = restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "thread-restore-v1".into(),
                project_id: "p1".into(),
                thread: Some(thread_snapshot("target")),
                links: vec![link_snapshot("link", "target")],
                branches: vec![branch_snapshot("branch", "source", "target")],
            },
        )
        .expect("restore aggregate v1");
        let thread_v1: PlotThreadSnapshotRow =
            serde_json::from_value(restored_v1["thread"].clone()).expect("thread v1");
        let link_v1: PlotThreadLinkSnapshotRow =
            serde_json::from_value(restored_v1["links"][0].clone()).expect("link v1");
        let branch_v1: PlotThreadBranchSnapshotRow =
            serde_json::from_value(restored_v1["branches"][0].clone()).expect("branch v1");
        assert_eq!(thread_v1.version, 1);
        assert_eq!(link_v1.version, 1);
        assert_eq!(branch_v1.version, 1);

        delete_snapshot(
            &d,
            PlotThreadDeleteSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "thread-delete-v1".into(),
                project_id: "p1".into(),
                thread: Some(thread_v1.clone()),
                link: None,
                links: vec![link_v1.clone()],
                branches: vec![branch_v1.clone()],
            },
        )
        .expect("delete exact aggregate v1");

        let restored_v2 = restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "thread-restore-v2".into(),
                project_id: "p1".into(),
                thread: Some(thread_v1.clone()),
                links: vec![link_v1.clone()],
                branches: vec![branch_v1.clone()],
            },
        )
        .expect("restore aggregate with fresh versions");
        assert_eq!(restored_v2["thread"]["version"], 2);
        assert_eq!(restored_v2["links"][0]["version"], 2);
        assert_eq!(restored_v2["branches"][0]["version"], 2);

        let stale = delete_snapshot(
            &d,
            PlotThreadDeleteSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "thread-delete-stale".into(),
                project_id: "p1".into(),
                thread: Some(thread_v1),
                link: None,
                links: vec![link_v1],
                branches: vec![branch_v1],
            },
        )
        .expect_err("a pre-restore snapshot must not delete the new generation");
        assert!(stale.to_string().contains("thread changed since snapshot"));

        let thread_v2: PlotThreadSnapshotRow =
            serde_json::from_value(restored_v2["thread"].clone()).expect("thread v2");
        let link_v2: PlotThreadLinkSnapshotRow =
            serde_json::from_value(restored_v2["links"][0].clone()).expect("link v2");
        let branch_v2: PlotThreadBranchSnapshotRow =
            serde_json::from_value(restored_v2["branches"][0].clone()).expect("branch v2");
        d.execute(
            "INSERT INTO plot_thread_scene_links
                (id, thread_id, node_id, phase_type, semantic_key, version)
             VALUES ('late-link','target','scene','develop','target|scene|develop',0)",
            &[],
            "run",
        )
        .unwrap();
        let incomplete = delete_snapshot(
            &d,
            PlotThreadDeleteSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "thread-delete-incomplete".into(),
                project_id: "p1".into(),
                thread: Some(thread_v2),
                link: None,
                links: vec![link_v2],
                branches: vec![branch_v2],
            },
        )
        .expect_err("a concurrently added child must reject the aggregate delete");
        assert!(incomplete.to_string().contains("link set changed"));
        let counts = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_threads WHERE id = 'target') AS threads,
                   (SELECT COUNT(*) FROM plot_thread_scene_links WHERE thread_id = 'target') AS links,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'branch') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE request_id IN ('thread-delete-stale','thread-delete-incomplete')) AS ledgers",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(counts[0]["threads"].as_i64(), Some(1));
        assert_eq!(counts[0]["links"].as_i64(), Some(2));
        assert_eq!(counts[0]["branches"].as_i64(), Some(1));
        assert_eq!(counts[0]["ledgers"].as_i64(), Some(0));
    }

    #[test]
    fn restore_snapshot_rolls_back_parent_and_ledger_when_child_validation_fails() {
        let d = db();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        let mut invalid_link = link_snapshot("bad-link", "target");
        invalid_link.node_id = "missing-scene".into();
        let error = restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "restore-invalid".into(),
                project_id: "p1".into(),
                thread: Some(thread_snapshot("target")),
                links: vec![invalid_link],
                branches: vec![],
            },
        )
        .expect_err("invalid child must roll back");
        assert!(error.to_string().contains("snapshot project"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_threads WHERE id = 'target') AS threads,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_restore_snapshot'
                       AND request_id = 'restore-invalid') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["threads"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn restore_snapshot_rejects_empty_row_identity_before_insert_or_ledger() {
        let d = db();
        let mut empty_id = thread_snapshot("");
        empty_id.start_node_id = None;
        empty_id.end_node_id = None;
        let error = restore_snapshot(
            &d,
            PlotThreadRestoreSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "restore-empty-id".into(),
                project_id: "p1".into(),
                thread: Some(empty_id),
                links: vec![],
                branches: vec![],
            },
        )
        .expect_err("empty row id");
        assert!(error.to_string().contains("thread.id"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_threads WHERE id = '') AS rows,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_restore_snapshot'
                       AND request_id = 'restore-empty-id') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["rows"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn restore_snapshot_rejects_same_request_with_changed_rows() {
        let d = db();
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene')",
            &[],
            "run",
        )
        .unwrap();
        let base = PlotThreadRestoreSnapshotPayload {
            session_id: "plot-test-session".to_string(),
            event_uid: RendererWriteContext::default().event_uid,
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            request_id: "restore-conflict".into(),
            project_id: "p1".into(),
            thread: Some(thread_snapshot("target")),
            links: vec![],
            branches: vec![],
        };
        restore_snapshot(&d, base.clone()).expect("initial restore");
        let mut changed = base;
        changed.thread.as_mut().expect("thread").name = "different".into();
        let error = restore_snapshot(&d, changed).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("PLOT_THREAD_RESTORE_IDEMPOTENCY_CONFLICT"));
    }

    fn seed_marker_delete_snapshot(d: &Database) {
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene','p1','scene','Scene');
             INSERT INTO plot_threads (id, project_id, name, sort_order)
             VALUES ('source','p1','source','a0'), ('target','p1','target','a1');
             INSERT INTO plot_thread_scene_links
               (id, thread_id, node_id, phase_type, note, sort_order,
                semantic_key, version, created_at, updated_at)
             VALUES
               ('link','target','scene','turn','marker','a0',
                'target|scene|turn',0,
                '2026-01-01T01:00:00.000Z','2026-01-02T01:00:00.000Z');
             INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                semantic_key, version, created_at, updated_at)
             VALUES
               ('branch','p1','source','target','scene','branch',
                'source|target|scene|branch',0,
                '2026-01-01T02:00:00.000Z','2026-01-02T02:00:00.000Z')",
            )?;
            Ok(())
        })
        .unwrap();
    }

    fn marker_move_payload(request_id: &str) -> PlotThreadMoveMarkerBundlePayload {
        let before = link_snapshot("link", "target");
        let mut after = before.clone();
        after.node_id = "scene-2".into();
        after.updated_at = "2026-01-03T01:00:00.000Z".into();
        let mut created_branch = branch_snapshot("moved-branch", "source", "target");
        created_branch.at_node_id = "scene-2".into();
        created_branch.updated_at = "2026-01-03T02:00:00.000Z".into();
        PlotThreadMoveMarkerBundlePayload {
            session_id: "plot-test-session".to_string(),
            event_uid: format!("plot-test-event-{request_id}"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            request_id: request_id.into(),
            project_id: "p1".into(),
            marker_before: before,
            marker_after: after,
            branch_transitions: vec![PlotThreadBranchTransition {
                before: None,
                after: Some(created_branch),
            }],
        }
    }

    fn seed_marker_move_bundle(d: &Database) {
        seed_marker_delete_snapshot(d);
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene-2','p1','scene','Scene 2')",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "DELETE FROM plot_thread_branches WHERE id = 'branch'",
            &[],
            "run",
        )
        .unwrap();
    }

    #[test]
    fn move_marker_bundle_commits_once_and_exact_retry_replays() {
        let d = db();
        seed_marker_move_bundle(&d);
        let first =
            move_marker_bundle(&d, marker_move_payload("move-request")).expect("marker move");
        assert_eq!(first["marker"]["nodeId"], Value::String("scene-2".into()));
        assert_eq!(first["marker"]["semanticKey"], "target|scene-2|turn");
        assert_eq!(first["marker"]["version"], 1);
        assert_eq!(
            first["branches"][0]["id"],
            Value::String("moved-branch".into())
        );
        assert_eq!(
            first["branches"][0]["semanticKey"],
            "source|target|scene-2|branch"
        );
        assert_eq!(first["branches"][0]["version"], 0);
        assert_eq!(first["__idempotency"]["replayed"], Value::Bool(false));

        let replay =
            move_marker_bundle(&d, marker_move_payload("move-request")).expect("exact replay");
        assert_eq!(replay["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(replay["__idempotency"]["entityPresent"], Value::Bool(true));
        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_thread_scene_links
                     WHERE id = 'link' AND node_id = 'scene-2') AS markers,
                   (SELECT COUNT(*) FROM plot_thread_branches
                     WHERE id = 'moved-branch') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_move_marker_bundle'
                       AND request_id = 'move-request') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["markers"].as_i64(), Some(1));
        assert_eq!(rows[0]["branches"].as_i64(), Some(1));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(1));

        let mut stale_marker: PlotThreadLinkSnapshotRow =
            serde_json::from_value(first["marker"].clone()).expect("current marker snapshot");
        stale_marker.version = 0;
        let mut stale_after = stale_marker.clone();
        stale_after.node_id = "scene".into();
        stale_after.semantic_key = Some("target|scene|turn".into());
        stale_after.updated_at = "2026-01-04T01:00:00.000Z".into();
        let stale = move_marker_bundle(
            &d,
            PlotThreadMoveMarkerBundlePayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                request_id: "move-stale-version".into(),
                project_id: "p1".into(),
                marker_before: stale_marker,
                marker_after: stale_after,
                branch_transitions: vec![],
            },
        )
        .expect_err("version-only stale marker snapshot must conflict");
        assert!(stale
            .to_string()
            .contains("PLOT_THREAD_MOVE_MARKER_PRECONDITION_FAILED"));

        let forward_marker: PlotThreadLinkSnapshotRow =
            serde_json::from_value(first["marker"].clone()).expect("forward marker snapshot");
        let forward_branch: PlotThreadBranchSnapshotRow =
            serde_json::from_value(first["branches"][0].clone()).expect("forward branch snapshot");
        let undo = move_marker_bundle(
            &d,
            PlotThreadMoveMarkerBundlePayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                request_id: "move-undo".into(),
                project_id: "p1".into(),
                marker_before: forward_marker.clone(),
                marker_after: link_snapshot("link", "target"),
                branch_transitions: vec![PlotThreadBranchTransition {
                    before: Some(forward_branch.clone()),
                    after: None,
                }],
            },
        )
        .expect("undo marker move with monotonic version");
        assert_eq!(undo["marker"]["nodeId"], "scene");
        assert_eq!(undo["marker"]["semanticKey"], "target|scene|turn");
        assert_eq!(undo["marker"]["version"], 2);
        assert!(undo["branches"].as_array().is_some_and(Vec::is_empty));

        let undo_marker: PlotThreadLinkSnapshotRow =
            serde_json::from_value(undo["marker"].clone()).expect("undo marker snapshot");
        let mut restored_branch = forward_branch;
        restored_branch.version = 1;
        let redo = move_marker_bundle(
            &d,
            PlotThreadMoveMarkerBundlePayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                request_id: "move-redo".into(),
                project_id: "p1".into(),
                marker_before: undo_marker,
                marker_after: forward_marker,
                branch_transitions: vec![PlotThreadBranchTransition {
                    before: None,
                    after: Some(restored_branch),
                }],
            },
        )
        .expect("redo marker move with monotonic version");
        assert_eq!(redo["marker"]["nodeId"], "scene-2");
        assert_eq!(redo["marker"]["version"], 3);
        assert_eq!(redo["branches"][0]["version"], 1);
    }

    #[test]
    fn move_marker_bundle_rolls_back_marker_when_branch_write_fails() {
        let d = db();
        seed_marker_move_bundle(&d);
        d.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER reject_moved_branch
                   BEFORE INSERT ON plot_thread_branches
                   WHEN NEW.id = 'moved-branch'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced branch failure');
                 END;",
            )?;
            Ok(())
        })
        .unwrap();

        let error = move_marker_bundle(&d, marker_move_payload("move-rollback"))
            .expect_err("branch failure must roll back marker");
        assert!(error.to_string().contains("forced branch failure"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT node_id FROM plot_thread_scene_links
                     WHERE id = 'link') AS marker_node,
                   (SELECT COUNT(*) FROM plot_thread_branches
                     WHERE id = 'moved-branch') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_move_marker_bundle'
                       AND request_id = 'move-rollback') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["marker_node"].as_str(), Some("scene"));
        assert_eq!(rows[0]["branches"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn move_marker_bundle_rejects_unrelated_branch_transitions_without_mutation() {
        let d = db();
        seed_marker_move_bundle(&d);
        let mut payload = marker_move_payload("move-unrelated-branch");
        payload.branch_transitions = vec![PlotThreadBranchTransition {
            before: None,
            after: Some(branch_snapshot("unrelated", "target", "source")),
        }];

        let error = move_marker_bundle(&d, payload)
            .expect_err("an unrelated branch must not be smuggled into a marker move");
        assert!(error.to_string().contains("must depend on markerAfter"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT node_id || ':' || version FROM plot_thread_scene_links
                     WHERE id = 'link') AS marker_state,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'unrelated') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_move_marker_bundle'
                       AND request_id = 'move-unrelated-branch') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["marker_state"].as_str(), Some("scene:0"));
        assert_eq!(rows[0]["branches"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn move_marker_bundle_rejects_an_unlisted_dependent_branch_without_mutation() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        d.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title)
             VALUES ('scene-2','p1','scene','Scene 2')",
            &[],
            "run",
        )
        .unwrap();

        let error = move_marker_bundle(&d, marker_move_payload("move-stale-dependencies"))
            .expect_err("an unlisted incoming branch must reject the entire move");
        assert!(error
            .to_string()
            .contains("dependent branch set changed since snapshot"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT node_id FROM plot_thread_scene_links WHERE id = 'link') AS marker_node,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'branch') AS old_branch,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'moved-branch') AS new_branch,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_move_marker_bundle'
                       AND request_id = 'move-stale-dependencies') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["marker_node"].as_str(), Some("scene"));
        assert_eq!(rows[0]["old_branch"].as_i64(), Some(1));
        assert_eq!(rows[0]["new_branch"].as_i64(), Some(0));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn move_marker_bundle_keeps_branches_when_a_coanchored_marker_remains() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene-2','p1','scene','Scene 2');
                 INSERT INTO plot_thread_scene_links
                   (id, thread_id, node_id, phase_type, semantic_key, version)
                 VALUES
                   ('coanchor','target','scene','develop','target|scene|develop',0);",
            )?;
            Ok(())
        })
        .unwrap();

        let mut payload = marker_move_payload("move-coanchored-marker");
        payload.branch_transitions.clear();
        let moved = move_marker_bundle(&d, payload).expect("move only one coanchored marker");
        assert_eq!(moved["marker"]["nodeId"], "scene-2");
        let rows = d
            .execute(
                "SELECT
                   (SELECT node_id FROM plot_thread_scene_links WHERE id = 'coanchor') AS coanchor_node,
                   (SELECT COUNT(*) FROM plot_thread_branches
                     WHERE id = 'branch' AND to_thread_id = 'target' AND at_node_id = 'scene') AS branches",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["coanchor_node"].as_str(), Some("scene"));
        assert_eq!(rows[0]["branches"].as_i64(), Some(1));
    }

    #[test]
    fn delete_snapshot_is_atomic_and_old_replay_does_not_delete_recreated_rows() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        let payload = || PlotThreadDeleteSnapshotPayload {
            session_id: "plot-test-session".to_string(),
            event_uid: "plot-test-event-delete-request-1".to_string(),
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            request_id: "delete-request-1".into(),
            project_id: "p1".into(),
            thread: None,
            link: Some(link_snapshot("link", "target")),
            links: vec![],
            branches: vec![branch_snapshot("branch", "source", "target")],
        };

        let first = delete_snapshot(&d, payload()).expect("delete snapshot");
        assert_eq!(first["deleted"], Value::Bool(true));
        let replay = delete_snapshot(&d, payload()).expect("delete replay");
        assert_eq!(replay["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(replay["__idempotency"]["entityPresent"], Value::Bool(true));

        d.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO plot_thread_scene_links
               (id, thread_id, node_id, phase_type, note, sort_order,
                semantic_key, version, created_at, updated_at)
             VALUES
               ('link','target','scene','turn','marker','a0',
                'target|scene|turn',0,
                '2026-01-01T01:00:00.000Z','2026-01-02T01:00:00.000Z');
             INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                semantic_key, version, created_at, updated_at)
             VALUES
               ('branch','p1','source','target','scene','branch',
                'source|target|scene|branch',0,
                '2026-01-01T02:00:00.000Z','2026-01-02T02:00:00.000Z')",
            )?;
            Ok(())
        })
        .unwrap();
        let stale_replay = delete_snapshot(&d, payload()).expect("stale replay");
        assert_eq!(
            stale_replay["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );
        assert!(
            d.execute(
                "SELECT id FROM plot_thread_scene_links WHERE id = 'link'",
                &[],
                "get",
            )
            .unwrap()
            .len()
                == 1
        );
    }

    #[test]
    fn delete_snapshot_rejects_incomplete_dependency_set_without_partial_delete() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        let error = delete_snapshot(
            &d,
            PlotThreadDeleteSnapshotPayload {
                session_id: "plot-test-session".to_string(),
                event_uid: RendererWriteContext::default().event_uid,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                request_id: "delete-invalid".into(),
                project_id: "p1".into(),
                thread: None,
                link: Some(link_snapshot("link", "target")),
                links: vec![],
                branches: vec![],
            },
        )
        .expect_err("missing dependent branch");
        assert!(error.to_string().contains("dependencies"));
        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_thread_scene_links WHERE id = 'link') AS links,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'branch') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_delete_snapshot'
                       AND request_id = 'delete-invalid') AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["links"].as_i64(), Some(1));
        assert_eq!(rows[0]["branches"].as_i64(), Some(1));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }

    #[test]
    fn delete_snapshot_rejects_changed_rows_before_claiming_the_ledger() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        let payload = |request_id: &str| PlotThreadDeleteSnapshotPayload {
            session_id: "plot-test-session".to_string(),
            event_uid: RendererWriteContext::default().event_uid,
            origin: NarrativeChangeOrigin::Restore,
            original_transaction_id: None,
            request_id: request_id.into(),
            project_id: "p1".into(),
            thread: None,
            link: Some(link_snapshot("link", "target")),
            links: vec![],
            branches: vec![branch_snapshot("branch", "source", "target")],
        };

        d.execute(
            "UPDATE plot_thread_scene_links
                SET note = 'changed after snapshot',
                    updated_at = '2026-01-03T01:00:00.000Z'
              WHERE id = 'link'",
            &[],
            "run",
        )
        .unwrap();
        let link_error = delete_snapshot(&d, payload("delete-stale-link"))
            .expect_err("changed link must not be deleted");
        assert!(link_error
            .to_string()
            .contains("PLOT_THREAD_DELETE_PRECONDITION_FAILED"));

        d.execute(
            "UPDATE plot_thread_scene_links
                SET note = 'marker',
                    updated_at = '2026-01-02T01:00:00.000Z'
              WHERE id = 'link'",
            &[],
            "run",
        )
        .unwrap();
        d.execute(
            "UPDATE plot_thread_branches
                SET kind = 'merge',
                    updated_at = '2026-01-03T02:00:00.000Z'
              WHERE id = 'branch'",
            &[],
            "run",
        )
        .unwrap();
        let branch_error = delete_snapshot(&d, payload("delete-stale-branch"))
            .expect_err("changed branch must not be deleted");
        assert!(branch_error
            .to_string()
            .contains("PLOT_THREAD_DELETE_PRECONDITION_FAILED"));

        let rows = d
            .execute(
                "SELECT
                   (SELECT COUNT(*) FROM plot_thread_scene_links WHERE id = 'link') AS links,
                   (SELECT COUNT(*) FROM plot_thread_branches WHERE id = 'branch') AS branches,
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'plot_thread_delete_snapshot'
                       AND request_id IN ('delete-stale-link', 'delete-stale-branch')) AS ledger",
                &[],
                "get",
            )
            .unwrap();
        assert_eq!(rows[0]["links"].as_i64(), Some(1));
        assert_eq!(rows[0]["branches"].as_i64(), Some(1));
        assert_eq!(rows[0]["ledger"].as_i64(), Some(0));
    }
}
