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

use rusqlite::Connection;
use serde_json::{json, Map, Value};

use super::{
    idempotency::{load_row, payload_fingerprint, run_atomic_create, IdempotencyRequest},
    Database,
};

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];
const BRANCH_KINDS: [&str; 2] = ["branch", "merge"];

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

/// 行 id の所属 project_id を引く。table は静的リテラルのみ（インジェクション無し）。
fn project_of(db: &Database, table: &str, id: &str) -> anyhow::Result<Option<String>> {
    db.with_conn(|conn| project_of_conn(conn, table, id))
}

fn project_of_conn(conn: &Connection, table: &str, id: &str) -> anyhow::Result<Option<String>> {
    let sql = format!("SELECT project_id FROM {table} WHERE id = ?");
    let rows = Database::execute_with_conn(conn, &sql, &[Value::String(id.to_string())], "get")?;
    Ok(rows
        .first()
        .and_then(|r| r.get("project_id"))
        .and_then(|v| v.as_str())
        .map(str::to_string))
}

// ─────────────────────── DTO ───────────────────────

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadCreatePayload {
    /// Domain-owned idempotency key. Renderer retries reuse this ID so a lost
    /// response cannot create a second logical thread.
    #[serde(default)]
    id: Option<String>,
    project_id: String,
    name: String,
    color: Option<String>,
    description: Option<String>,
    sort_order: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadPatch {
    name: Option<String>,
    color: Option<Option<String>>,
    description: Option<Option<String>>,
    sort_order: Option<String>,
    #[serde(default)]
    base_version: Option<i64>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkCreatePayload {
    /// Domain-owned idempotency key for renderer retries.
    #[serde(default)]
    id: Option<String>,
    thread_id: String,
    node_id: String,
    phase_type: String,
    note: Option<String>,
    sort_order: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadLinkPatch {
    thread_id: Option<String>,
    node_id: Option<String>,
    phase_type: Option<String>,
    note: Option<Option<String>>,
    sort_order: Option<Option<String>>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadBranchCreatePayload {
    /// Domain-owned idempotency key for renderer retries.
    #[serde(default)]
    id: Option<String>,
    project_id: String,
    from_thread_id: String,
    to_thread_id: String,
    at_node_id: String,
    kind: String,
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
    project_id: String,
    #[serde(default)]
    thread: Option<PlotThreadSnapshotRow>,
    #[serde(default)]
    links: Vec<PlotThreadLinkSnapshotRow>,
    #[serde(default)]
    branches: Vec<PlotThreadBranchSnapshotRow>,
}

/// Marker deletion is a compound mutation because branches are anchored to a
/// marker semantically even though SQLite has no FK from branch to link.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlotThreadDeleteSnapshotPayload {
    request_id: String,
    project_id: String,
    link: PlotThreadLinkSnapshotRow,
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
    project_id: String,
    marker_before: PlotThreadLinkSnapshotRow,
    marker_after: PlotThreadLinkSnapshotRow,
    #[serde(default)]
    branch_transitions: Vec<PlotThreadBranchTransition>,
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
}

fn link_row_matches(row: &Map<String, Value>, expected: &PlotThreadLinkSnapshotRow) -> bool {
    row_string(row, "id") == Some(expected.id.as_str())
        && row_string(row, "thread_id") == Some(expected.thread_id.as_str())
        && row_string(row, "node_id") == Some(expected.node_id.as_str())
        && row_string(row, "phase_type") == Some(expected.phase_type.as_str())
        && row.get("note") == Some(&nullable_string_value(&expected.note))
        && row.get("sort_order") == Some(&nullable_string_value(&expected.sort_order))
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
            require_project_member(
                conn,
                "tree_nodes",
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
        require_project_member(
            conn,
            "tree_nodes",
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
        require_project_member(
            conn,
            "tree_nodes",
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
              start_node_id, end_node_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
             (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(row.id.clone()),
            Value::String(row.thread_id.clone()),
            Value::String(row.node_id.clone()),
            Value::String(row.phase_type.clone()),
            nullable_string_value(&row.note),
            nullable_string_value(&row.sort_order),
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
              created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(row.id.clone()),
            Value::String(row.project_id.clone()),
            Value::String(row.from_thread_id.clone()),
            Value::String(row.to_thread_id.clone()),
            Value::String(row.at_node_id.clone()),
            Value::String(row.kind.clone()),
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
    let payload_hash = payload_fingerprint("plot_thread_create", &p)?;
    let has_request_id = p.id.is_some();
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
            request_id: has_request_id.then_some(id.as_str()),
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
            Ok((project_id.clone(), row))
        },
        |conn| load_row(conn, "plot_threads", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn update(db: &Database, id: String, patch: PlotThreadPatch) -> anyhow::Result<Value> {
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
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_threads WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("version = version + 1");
    sets.push("updated_at = datetime('now')");
    let sql = format!("UPDATE plot_threads SET {} WHERE id = ?", sets.join(", "));
    params.push(Value::String(id.clone()));
    if let Some(base_version) = patch.base_version {
        let full_sql = format!("{sql} AND version = ?");
        params.push(Value::Number(base_version.into()));
        let updated = db.with_conn(|conn| {
            Database::execute_with_conn(conn, &full_sql, &params, "run")?;
            Ok(conn.changes())
        })?;
        if updated == 0 {
            anyhow::bail!("plot thread '{id}' version conflict during update");
        }
    } else {
        db.execute(&sql, &params, "run")?;
    }
    Ok(one(db.execute(
        "SELECT * FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM plot_threads WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
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
    let payload_hash = payload_fingerprint("plot_thread_link_create", &p)?;
    let has_request_id = p.id.is_some();
    let id = p.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let thread_id = p.thread_id;
    let node_id = p.node_id;
    let phase_type = p.phase_type;
    let note = p.note;
    let sort_order = p.sort_order;
    run_atomic_create(
        db,
        IdempotencyRequest {
            domain: "plot_thread_link_create",
            request_id: has_request_id.then_some(id.as_str()),
            payload_hash: &payload_hash,
            conflict_marker: "PLOT_THREAD_LINK_IDEMPOTENCY_CONFLICT",
        },
        |conn| {
            validate_phase(&phase_type)?;
            // XPROJ is evaluated after the durable replay lookup. An exact
            // replay can therefore return its original response even when a
            // later cascade removed the thread or scene.
            let thread_project = project_of_conn(conn, "plot_threads", &thread_id)?;
            let node_project = project_of_conn(conn, "tree_nodes", &node_id)?;
            let project_id = match (thread_project, node_project) {
                (Some(thread_project), Some(node_project))
                    if thread_project == node_project =>
                {
                    thread_project
                }
                _ => {
                    anyhow::bail!(
                        "plot thread link must reference a thread and scene in the same project"
                    )
                }
            };
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
            Ok((project_id, row))
        },
        |conn| load_row(conn, "plot_thread_scene_links", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn link_update(db: &Database, id: String, patch: PlotThreadLinkPatch) -> anyhow::Result<Value> {
    if let Some(ref pt) = patch.phase_type {
        validate_phase(pt)?;
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut params: Vec<Value> = Vec::new();
    // 別スレッドへ移動する場合は XPROJ ガード: 移動先スレッドと（変更後の）シーンが
    // 同一 project であることを強制する。node_id が同 patch に無ければ既存値を引く。
    if let Some(ref new_thread_id) = patch.thread_id {
        let effective_node_id: Option<String> = match &patch.node_id {
            Some(n) => Some(n.clone()),
            None => db
                .execute(
                    "SELECT node_id FROM plot_thread_scene_links WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?
                .first()
                .and_then(|r| r.get("node_id"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
        };
        let thread_project = project_of(db, "plot_threads", new_thread_id)?;
        let node_project = match &effective_node_id {
            Some(n) => project_of(db, "tree_nodes", n)?,
            None => None,
        };
        match (thread_project, node_project) {
            (Some(a), Some(b)) if a == b => {}
            _ => {
                return Err(anyhow::anyhow!(
                    "plot thread link move must stay within the same project"
                ))
            }
        }
        sets.push("thread_id = ?");
        params.push(Value::String(new_thread_id.clone()));
    }
    if let Some(node_id) = patch.node_id {
        sets.push("node_id = ?");
        params.push(Value::String(node_id));
    }
    if let Some(phase_type) = patch.phase_type {
        sets.push("phase_type = ?");
        params.push(Value::String(phase_type));
    }
    if let Some(note) = patch.note {
        sets.push("note = ?");
        params.push(note.map(Value::String).unwrap_or(Value::Null));
    }
    if let Some(sort_order) = patch.sort_order {
        sets.push("sort_order = ?");
        params.push(sort_order.map(Value::String).unwrap_or(Value::Null));
    }
    if sets.is_empty() {
        return Ok(one(db.execute(
            "SELECT * FROM plot_thread_scene_links WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?));
    }
    sets.push("updated_at = datetime('now')");
    params.push(Value::String(id.clone()));
    let sql = format!(
        "UPDATE plot_thread_scene_links SET {} WHERE id = ?",
        sets.join(", ")
    );
    db.execute(&sql, &params, "run")?;
    Ok(one(db.execute(
        "SELECT * FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?))
}

pub fn link_delete(db: &Database, id: String) -> anyhow::Result<()> {
    db.execute(
        "DELETE FROM plot_thread_scene_links WHERE id = ?",
        &[Value::String(id)],
        "run",
    )?;
    Ok(())
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

/// Create a plot branch through the native domain boundary. Update/delete/list
/// remain generic Drizzle operations, but create owns the durable request
/// ledger and XPROJ validation and therefore must be one native transaction.
pub fn branch_create(db: &Database, p: PlotThreadBranchCreatePayload) -> anyhow::Result<Value> {
    let payload_hash = payload_fingerprint("plot_thread_branch_create", &p)?;
    let has_request_id = p.id.is_some();
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
            request_id: has_request_id.then_some(id.as_str()),
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
            let node_project = project_of_conn(conn, "tree_nodes", &at_node_id)?;
            match (from_project, to_project, node_project) {
                (Some(from), Some(to), Some(node))
                    if from == project_id && to == project_id && node == project_id => {}
                _ => anyhow::bail!(
                    "plot thread branch must reference a project, threads, and scene in the same project"
                ),
            }

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
            Ok((project_id.clone(), row))
        },
        |conn| load_row(conn, "plot_thread_branches", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

fn validate_move_link_row(label: &str, row: &PlotThreadLinkSnapshotRow) -> anyhow::Result<()> {
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
        }
        if let Some(after) = &transition.after {
            validate_move_branch_row(
                &format!("branchTransitions[{index}].after"),
                after,
                &payload.project_id,
            )?;
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
        require_project_member(
            conn,
            "tree_nodes",
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
            require_project_member(
                conn,
                "tree_nodes",
                &branch.at_node_id,
                &payload.project_id,
                "plot marker move branch scene",
            )?;
        }
    }
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

fn replace_link_row(conn: &Connection, row: &PlotThreadLinkSnapshotRow) -> anyhow::Result<()> {
    Database::execute_with_conn(
        conn,
        "UPDATE plot_thread_scene_links
            SET thread_id = ?, node_id = ?, phase_type = ?, note = ?,
                sort_order = ?, created_at = ?, updated_at = ?
          WHERE id = ?",
        &[
            Value::String(row.thread_id.clone()),
            Value::String(row.node_id.clone()),
            Value::String(row.phase_type.clone()),
            nullable_string_value(&row.note),
            nullable_string_value(&row.sort_order),
            Value::String(row.created_at.clone()),
            Value::String(row.updated_at.clone()),
            Value::String(row.id.clone()),
        ],
        "run",
    )?;
    Ok(())
}

fn replace_branch_row(conn: &Connection, row: &PlotThreadBranchSnapshotRow) -> anyhow::Result<()> {
    Database::execute_with_conn(
        conn,
        "UPDATE plot_thread_branches
            SET project_id = ?, from_thread_id = ?, to_thread_id = ?,
                at_node_id = ?, kind = ?, created_at = ?, updated_at = ?
          WHERE id = ?",
        &[
            Value::String(row.project_id.clone()),
            Value::String(row.from_thread_id.clone()),
            Value::String(row.to_thread_id.clone()),
            Value::String(row.at_node_id.clone()),
            Value::String(row.kind.clone()),
            Value::String(row.created_at.clone()),
            Value::String(row.updated_at.clone()),
            Value::String(row.id.clone()),
        ],
        "run",
    )?;
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
    payload: PlotThreadMoveMarkerBundlePayload,
) -> anyhow::Result<Value> {
    validate_move_marker_bundle_shape(&payload)?;
    let request_id = payload.request_id.clone();
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
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

            replace_link_row(conn, &payload.marker_after)?;
            for transition in &payload.branch_transitions {
                match (&transition.before, &transition.after) {
                    (None, Some(after)) => insert_or_validate_branch(conn, after)?,
                    (Some(_), Some(after)) => replace_branch_row(conn, after)?,
                    (Some(before), None) => {
                        Database::execute_with_conn(
                            conn,
                            "DELETE FROM plot_thread_branches WHERE id = ?",
                            &[Value::String(before.id.clone())],
                            "run",
                        )?;
                    }
                    (None, None) => {
                        anyhow::bail!("plot marker move branch transition has no rows")
                    }
                }
            }
            reject_duplicate_branch_topology(
                conn,
                payload
                    .branch_transitions
                    .iter()
                    .filter_map(|transition| transition.after.clone()),
            )?;
            Ok((
                payload.project_id.clone(),
                move_marker_bundle_response(&request_id, &payload),
            ))
        },
        |conn| move_marker_bundle_effect_present(conn, &request_id, &payload),
    )
    .map(|outcome| outcome.into_wire_value())
}

// ─────────────────────── history snapshot transactions ───────────────────────

pub fn restore_snapshot(
    db: &Database,
    payload: PlotThreadRestoreSnapshotPayload,
) -> anyhow::Result<Value> {
    validate_restore_snapshot_shape(&payload)?;
    let request_id = payload.request_id.clone();
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "thread": payload.thread,
        "links": payload.links,
        "branches": payload.branches,
    });
    let payload_hash = payload_fingerprint("plot_thread_restore_snapshot", &fingerprint_payload)?;

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
            if let Some(thread) = &payload.thread {
                insert_or_validate_thread(conn, thread)?;
            }
            validate_restore_snapshot_membership(conn, &payload)?;
            for link in &payload.links {
                insert_or_validate_link(conn, link)?;
            }
            for branch in &payload.branches {
                insert_or_validate_branch(conn, branch)?;
            }
            Ok((
                payload.project_id.clone(),
                restore_snapshot_response(&request_id, &payload),
            ))
        },
        |conn| load_exact_restore_snapshot(conn, &request_id, &payload),
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
    require_project_member(
        conn,
        "tree_nodes",
        node_id,
        project_id,
        "plot delete snapshot link scene",
    )?;

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
    if load_row(conn, "plot_thread_scene_links", &payload.link.id)?.is_some() {
        return Ok(None);
    }
    for branch in &payload.branches {
        if load_row(conn, "plot_thread_branches", &branch.id)?.is_some() {
            return Ok(None);
        }
    }
    Ok(Some(json!({ "id": request_id, "deleted": true })))
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
    if payload.link.id.is_empty()
        || payload.link.thread_id.is_empty()
        || payload.link.node_id.is_empty()
        || payload.link.phase_type.is_empty()
        || payload.link.created_at.is_empty()
        || payload.link.updated_at.is_empty()
    {
        anyhow::bail!("plot delete snapshot link identity and timestamps must be non-empty");
    }
    validate_phase(&payload.link.phase_type)?;
    let mut unique_branch_ids = payload
        .branches
        .iter()
        .map(|branch| branch.id.clone())
        .collect::<Vec<_>>();
    if payload.branches.iter().any(|branch| {
        branch.id.is_empty()
            || branch.project_id.is_empty()
            || branch.from_thread_id.is_empty()
            || branch.to_thread_id.is_empty()
            || branch.at_node_id.is_empty()
            || branch.kind.is_empty()
            || branch.created_at.is_empty()
            || branch.updated_at.is_empty()
    }) {
        anyhow::bail!("plot delete snapshot branch identity and timestamps must be non-empty");
    }
    for branch in &payload.branches {
        validate_branch_kind(&branch.kind)?;
        if branch.from_thread_id == branch.to_thread_id {
            anyhow::bail!("plot thread branch cannot reference the same thread twice");
        }
    }
    unique_branch_ids.sort();
    unique_branch_ids.dedup();
    if unique_branch_ids.len() != payload.branches.len() {
        anyhow::bail!("plot delete snapshot contains duplicate branch ids");
    }

    let request_id = payload.request_id.clone();
    let fingerprint_payload = json!({
        "projectId": payload.project_id,
        "link": payload.link,
        "branches": payload.branches,
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
            let link = load_map(conn, "plot_thread_scene_links", &payload.link.id)?
                .ok_or_else(|| anyhow::anyhow!("plot delete snapshot link does not exist"))?;
            if !link_row_matches(&link, &payload.link) {
                anyhow::bail!(
                    "PLOT_THREAD_DELETE_PRECONDITION_FAILED: link changed since snapshot"
                );
            }
            require_project_member(
                conn,
                "plot_threads",
                &payload.link.thread_id,
                &payload.project_id,
                "plot delete snapshot link thread",
            )?;
            require_project_member(
                conn,
                "tree_nodes",
                &payload.link.node_id,
                &payload.project_id,
                "plot delete snapshot link scene",
            )?;
            let mut expected =
                expected_delete_branch_ids(conn, &payload.project_id, &payload.link.id)?;
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
                if branch.project_id != payload.project_id {
                    anyhow::bail!(
                        "plot delete snapshot branch must belong to the snapshot project"
                    );
                }
                require_project_member(
                    conn,
                    "plot_threads",
                    &branch.from_thread_id,
                    &payload.project_id,
                    "plot delete snapshot branch source thread",
                )?;
                require_project_member(
                    conn,
                    "plot_threads",
                    &branch.to_thread_id,
                    &payload.project_id,
                    "plot delete snapshot branch target thread",
                )?;
                require_project_member(
                    conn,
                    "tree_nodes",
                    &branch.at_node_id,
                    &payload.project_id,
                    "plot delete snapshot branch scene",
                )?;
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
                    "DELETE FROM plot_thread_branches WHERE id = ?",
                    &[Value::String(branch.id.clone())],
                    "run",
                )?;
            }
            Database::execute_with_conn(
                conn,
                "DELETE FROM plot_thread_scene_links WHERE id = ?",
                &[Value::String(payload.link.id.clone())],
                "run",
            )?;
            Ok((
                payload.project_id.clone(),
                json!({ "id": request_id, "deleted": true }),
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

    #[test]
    fn create_then_list_roundtrips() {
        let d = db();
        let created = create(
            &d,
            PlotThreadCreatePayload {
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
        let first = create(
            &d,
            PlotThreadCreatePayload {
                id: Some("request-1".into()),
                project_id: "p1".into(),
                name: "retry-safe".into(),
                color: Some("#123".into()),
                description: Some("same logical request".into()),
                sort_order: "a0".into(),
            },
        )
        .unwrap();
        let retried = create(
            &d,
            PlotThreadCreatePayload {
                id: Some("request-1".into()),
                project_id: "p1".into(),
                name: "retry-safe".into(),
                color: Some("#123".into()),
                description: Some("same logical request".into()),
                sort_order: "a0".into(),
            },
        )
        .unwrap();

        assert_eq!(first.get("id"), retried.get("id"));
        assert_eq!(retried["__idempotency"]["replayed"], Value::Bool(true));
        assert_eq!(retried["__idempotency"]["entityPresent"], Value::Bool(true));
        delete(&d, "request-1".to_string()).expect("delete thread");
        let deleted_retry = create(
            &d,
            PlotThreadCreatePayload {
                id: Some("request-1".into()),
                project_id: "p1".into(),
                name: "retry-safe".into(),
                color: Some("#123".into()),
                description: Some("same logical request".into()),
                sort_order: "a0".into(),
            },
        )
        .expect("retry after delete");
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );
        assert!(list(&d, "p1".into()).unwrap().is_empty());
    }

    #[test]
    fn create_rejects_domain_id_reuse_with_different_input() {
        let d = db();
        create(
            &d,
            PlotThreadCreatePayload {
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

        let first = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                id: Some("link-request-1".into()),
                thread_id: "t1".into(),
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: Some("same".into()),
                sort_order: None,
            },
        )
        .unwrap();
        let retried = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                id: Some("link-request-1".into()),
                thread_id: "t1".into(),
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: Some("same".into()),
                sort_order: None,
            },
        )
        .unwrap();
        assert_eq!(first.get("id"), retried.get("id"));
        assert_eq!(retried["__idempotency"]["entityPresent"], Value::Bool(true));
        link_delete(&d, "link-request-1".to_string()).expect("delete link");
        let deleted_retry = link_create(
            &d,
            PlotThreadLinkCreatePayload {
                id: Some("link-request-1".into()),
                thread_id: "t1".into(),
                node_id: "s1".into(),
                phase_type: "introduce".into(),
                note: Some("same".into()),
                sort_order: None,
            },
        )
        .expect("retry after link delete");
        assert_eq!(
            deleted_retry["__idempotency"]["entityPresent"],
            Value::Bool(false)
        );

        let conflict = link_create(
            &d,
            PlotThreadLinkCreatePayload {
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
            "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES ('c','p2','c','a0')",
            &[],
            "run",
        )
        .unwrap();
        let link = link_create(
            &d,
            PlotThreadLinkCreatePayload {
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
                thread_id: Some("b".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
            },
        )
        .unwrap();
        assert_eq!(
            ok.as_object()
                .and_then(|o| o.get("thread_id"))
                .and_then(|v| v.as_str()),
            Some("b")
        );

        // 別 project の thread c へ移動 → 拒否。
        let cross = link_update(
            &d,
            lid,
            PlotThreadLinkPatch {
                thread_id: Some("c".into()),
                node_id: None,
                phase_type: None,
                note: None,
                sort_order: None,
            },
        );
        assert!(cross.is_err(), "cross-project thread move must be rejected");
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
            created_at: "2026-01-01T02:00:00.000Z".into(),
            updated_at: "2026-01-02T02:00:00.000Z".into(),
        }
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
               (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
             VALUES
               ('link','target','scene','turn','marker','a0',
                '2026-01-01T01:00:00.000Z','2026-01-02T01:00:00.000Z');
             INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                created_at, updated_at)
             VALUES
               ('branch','p1','source','target','scene','branch',
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
        assert_eq!(
            first["branches"][0]["id"],
            Value::String("moved-branch".into())
        );
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
    fn delete_snapshot_is_atomic_and_old_replay_does_not_delete_recreated_rows() {
        let d = db();
        seed_marker_delete_snapshot(&d);
        let payload = || PlotThreadDeleteSnapshotPayload {
            request_id: "delete-request-1".into(),
            project_id: "p1".into(),
            link: link_snapshot("link", "target"),
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
               (id, thread_id, node_id, phase_type, note, sort_order, created_at, updated_at)
             VALUES
               ('link','target','scene','turn','marker','a0',
                '2026-01-01T01:00:00.000Z','2026-01-02T01:00:00.000Z');
             INSERT INTO plot_thread_branches
               (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
                created_at, updated_at)
             VALUES
               ('branch','p1','source','target','scene','branch',
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
                request_id: "delete-invalid".into(),
                project_id: "p1".into(),
                link: link_snapshot("link", "target"),
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
            request_id: request_id.into(),
            project_id: "p1".into(),
            link: link_snapshot("link", "target"),
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
