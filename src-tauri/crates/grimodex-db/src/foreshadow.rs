//! Foreshadow (伏線) の DB 操作。
//!
//! 実装本体を旧 `src-tauri/src/commands/foreshadow.rs` から本クレートへ移動した
//! (Electron 移行 Phase 3 バッチ1 — Tauri コマンドと napi `Backend` の両方が薄い
//! ラッパーとして呼ぶ。`trash_bin` / `plot_threads` と同じ構図)。SQL・検証・
//! エラー文字列・Option<Option<T>> patch の 3 値挙動は移動前と完全に同一。
//!
//! すべて純 `db.execute` / `db.execute_batch_tx` で、`grimodex_core::writes`
//! (undo_journal / change_events の tracked write) は使わない。tracked な
//! foreshadow 生成は agent_writes 側の別コマンド。

use std::collections::{BTreeSet, HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{
    idempotency::{load_row, payload_fingerprint, run_atomic_create, IdempotencyRequest},
    Database,
};
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};

type PayoffRootState = (Option<String>, Option<i64>, Option<i64>, i64);

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
    #[serde(default)]
    request_id: Option<String>,
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
    setup_id: String,
    base_version: i64,
    action: String,
    scene_id: Option<String>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupAnchorInput {
    id: String,
    foreshadow_id: String,
    base_version: i64,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Deserialize)]
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
    let request_id = payload.request_id.clone().or_else(|| payload.id.clone());
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
    });
    let payload_hash = payload_fingerprint("foreshadow_create", &fingerprint_payload)?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = payload
        .id
        .or_else(|| request_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
            request_id: request_id.as_deref(),
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
                let scene = Database::execute_with_conn(
                    conn,
                    "SELECT project_id FROM tree_nodes WHERE id = ?",
                    &[Value::String(scene_id.to_string())],
                    "get",
                )?;
                if scene.first().and_then(|row| row.get("project_id")).and_then(Value::as_str)
                    != Some(project_id.as_str())
                {
                    return Err(anyhow::anyhow!(
                        "foreshadow payoff scene must belong to the same project"
                    ));
                }
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
            Ok((project_id.clone(), row))
        },
        |conn| load_row(conn, "foreshadows", &id),
    )
    .map(|outcome| outcome.into_wire_value())
}

pub fn update(db: &Database, id: String, patch: ForeshadowPatch) -> anyhow::Result<Value> {
    anyhow::ensure!(
        patch.base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    let base_version = patch.base_version;
    if let Some(ref lb) = patch.load_bearing {
        validate_load_bearing(lb.as_deref())?;
    }
    let payoff_scene_for_validation = patch
        .payoff_scene_id
        .as_ref()
        .and_then(|scene_id| scene_id.clone());
    let now = chrono::Utc::now().timestamp_millis();
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
        let rows = db.execute(
            "SELECT * FROM foreshadows WHERE id = ? AND version = ?",
            &[Value::String(id), Value::Number(base_version.into())],
            "get",
        )?;
        anyhow::ensure!(
            !rows.is_empty(),
            "FORESHADOW_VERSION_MISMATCH: row missing or expected version {base_version} is stale"
        );
        return Ok(Value::Object(rows[0].clone()));
    }

    sets.push("version = version + 1");
    sets.push("updated_at = ?");
    params.push(Value::Number(now.into()));
    params.push(Value::String(id.clone()));
    params.push(Value::Number(base_version.into()));

    let sql = format!(
        "UPDATE foreshadows SET {} WHERE id = ? AND version = ?",
        sets.join(", ")
    );
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            if let Some(scene_id) = payoff_scene_for_validation.as_deref() {
                let owner = Database::execute_with_conn(
                    conn,
                    "SELECT project_id FROM foreshadows WHERE id = ?",
                    &[Value::String(id.clone())],
                    "get",
                )?;
                if let Some(owner_project_id) = owner
                    .first()
                    .and_then(|row| row.get("project_id"))
                    .and_then(Value::as_str)
                {
                    let payoff_scene = Database::execute_with_conn(
                        conn,
                        "SELECT project_id FROM tree_nodes WHERE id = ?",
                        &[Value::String(scene_id.to_string())],
                        "get",
                    )?;
                    if payoff_scene
                        .first()
                        .and_then(|row| row.get("project_id"))
                        .and_then(Value::as_str)
                        != Some(owner_project_id)
                    {
                        return Err(anyhow::anyhow!(
                            "foreshadow payoff scene must belong to the same project"
                        ));
                    }
                }
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
            Ok(rows
                .first()
                .cloned()
                .map(Value::Object)
                .unwrap_or(Value::Null))
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

pub fn delete(
    db: &Database,
    id: String,
    project_id: String,
    base_version: i64,
    session_id: String,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        base_version >= 0,
        "foreshadow baseVersion must be non-negative"
    );
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    with_immediate_transaction(db, |conn| {
        let before =
            crate::narrative_extraction::collect_aggregate_snapshot(conn, &project_id, &id)
                .map_err(|error| {
                    anyhow::anyhow!(
                        "FORESHADOW_VERSION_MISMATCH: row missing or inaccessible: {error}"
                    )
                })?;
        let current_version = before
            .get("version")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow::anyhow!("foreshadow snapshot missing version before delete"))?;
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
        append_change_events_in_tx(
            conn,
            &project_id,
            &session_id,
            &[AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: None,
                domain: "foreshadow".to_string(),
                op_type: "foreshadow.delete".to_string(),
                entity_type: Some("foreshadow".to_string()),
                entity_id: Some(id.clone()),
                payload: serde_json::json!({ "baseVersion": base_version }).to_string(),
                timestamp,
            }],
        )?;

        Ok(serde_json::json!({
            "entityId": id,
            "projectId": project_id,
            "version": current_version,
            "changeEventUid": event_uid,
            "undoJournalId": undo_id,
        }))
    })
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
    let now = chrono::Utc::now().timestamp_millis();
    let base_version = patch.base_version;
    with_immediate_transaction(db, |conn| {
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
        finish_foreshadow_child_write(conn, &foreshadow_id, changed, Some(base_version), now)
    })
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

pub fn link_codex(
    db: &Database,
    foreshadow_id: String,
    codex_id: String,
    base_version: i64,
) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    with_immediate_transaction(db, |conn| {
        let projects: Option<(String, String)> = conn
            .query_row(
                "SELECT f.project_id, ce.project_id
                   FROM foreshadows f
                   JOIN codex_entries ce ON ce.id = ?2
                  WHERE f.id = ?1",
                params![foreshadow_id, codex_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if !matches!(projects, Some((ref left, ref right)) if left == right) {
            anyhow::bail!("foreshadow Codex link must stay within one project");
        }
        let changed = conn.execute(
            "INSERT OR IGNORE INTO foreshadow_codex_links
                (foreshadow_id, codex_entry_id) VALUES (?1, ?2)",
            params![foreshadow_id, codex_id],
        )? == 1;
        finish_foreshadow_child_write(conn, &foreshadow_id, changed, Some(base_version), now)
    })
}

pub fn unlink_codex(
    db: &Database,
    foreshadow_id: String,
    codex_id: String,
    base_version: i64,
) -> anyhow::Result<Value> {
    // The IPC contract carries globally unique entity ids but no project id.
    // Scope deletion to the exact composite association; intentionally do not
    // require same-project ownership here so legacy invalid links remain
    // removable after `link_codex` starts rejecting their creation.
    let now = chrono::Utc::now().timestamp_millis();
    with_immediate_transaction(db, |conn| {
        let changed = conn.execute(
            "DELETE FROM foreshadow_codex_links
              WHERE foreshadow_id = ?1 AND codex_entry_id = ?2",
            params![foreshadow_id, codex_id],
        )? == 1;
        finish_foreshadow_child_write(conn, &foreshadow_id, changed, Some(base_version), now)
    })
}

/// impact-review: Codex 埋め込み対象フィールド更新時に、リンク伏線へ再評価ダーティ印を付ける。
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
    setup_id: String,
    strength: Option<String>,
    base_version: i64,
) -> anyhow::Result<Value> {
    update_setup(
        db,
        setup_id,
        ForeshadowSetupPatch {
            base_version,
            strength: Some(strength),
            ai_strength: None,
            ai_reasoning: None,
            is_orphan: None,
            last_evaluated_at: None,
        },
    )
}

pub fn setup_create_ai(db: &Database, input: SetupCreateAiInput) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
    with_immediate_transaction(db, |conn| {
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
        finish_foreshadow_child_write(
            conn,
            &input.foreshadow_id,
            changed,
            Some(input.base_version),
            now,
        )
    })
}

pub fn resolve_orphan(db: &Database, payload: OrphanResolvePayload) -> anyhow::Result<Value> {
    let now = chrono::Utc::now().timestamp_millis();
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
            with_immediate_transaction(db, |conn| {
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
                let foreshadow = finish_foreshadow_child_write(
                    conn,
                    &foreshadow_id,
                    changed,
                    Some(payload.base_version),
                    now,
                )?;
                Ok(serde_json::json!({ "setupId": null, "foreshadow": foreshadow }))
            })
        }
        "delete" => with_immediate_transaction(db, |conn| {
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
            let changed = conn.execute(
                "DELETE FROM foreshadow_setups WHERE id = ?1",
                params![payload.setup_id],
            )? == 1;
            let foreshadow = finish_foreshadow_child_write(
                conn,
                &foreshadow_id,
                changed,
                Some(payload.base_version),
                now,
            )?;
            Ok(serde_json::json!({ "setupId": null, "foreshadow": foreshadow }))
        }),
        "reinsert" => with_immediate_transaction(db, |conn| {
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
            let foreshadow = finish_foreshadow_child_write(
                conn,
                &foreshadow_id,
                true,
                Some(payload.base_version),
                now,
            )?;
            Ok(serde_json::json!({ "setupId": new_id, "foreshadow": foreshadow }))
        }),
        _ => Ok(serde_json::json!({ "setupId": null, "foreshadow": null })),
    }
}

pub fn save_anchors_for_scene(
    db: &Database,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
    base_versions: HashMap<String, i64>,
    doc_content_size: i64,
) -> anyhow::Result<Vec<Value>> {
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
    with_immediate_transaction(db, |conn| {
        let mut touched_roots = BTreeSet::new();
        let mut changed_roots = BTreeSet::new();

        // Validate every payoff token against the pre-write aggregate state.
        // Root versions are advanced only after all setup/payoff changes have
        // been applied, so one root can safely carry both kinds in one save.
        for payoff in &payoffs {
            validate_setup_anchor_ownership(conn, &payoff.foreshadow_id, &payoff.scene_id)?;
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
            }
        }

        let valid_setup_ids: HashSet<&str> = setups.iter().map(|setup| setup.id.as_str()).collect();
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
                    let changed = conn.execute(
                        "UPDATE foreshadow_setups
                            SET is_orphan = 1, updated_at = ?1
                          WHERE id = ?2 AND is_orphan IS NOT 1",
                        params![now, setup_id],
                    )? == 1;
                    if changed {
                        changed_roots.insert(foreshadow_id.clone());
                    }
                    touched_roots.insert(foreshadow_id);
                }
            }
        }

        let mut authoritative = Vec::with_capacity(touched_roots.len());
        for foreshadow_id in touched_roots {
            let expected_base_version = *base_versions.get(&foreshadow_id).ok_or_else(|| {
                anyhow::anyhow!(
                    "FORESHADOW_VERSION_MISMATCH: scene snapshot has no baseVersion for '{}'",
                    foreshadow_id
                )
            })?;
            authoritative.push(finish_foreshadow_child_write(
                conn,
                &foreshadow_id,
                changed_roots.contains(&foreshadow_id),
                Some(expected_base_version),
                now,
            )?);
        }
        Ok(authoritative)
    })
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
    use std::path::Path;

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
        id: &str,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
    ) -> SetupCreateAiInput {
        SetupCreateAiInput {
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

        link_codex(&db, foreshadow_id.clone(), local_codex_id.clone(), 0)
            .expect("same-project link");
        let error = link_codex(&db, foreshadow_id.clone(), foreign_codex_id, 1)
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
        link_codex(&db, first_foreshadow_id.clone(), local_codex_id.clone(), 0)
            .expect("first local link");
        link_codex(&db, second_foreshadow_id.clone(), local_codex_id.clone(), 0)
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

        unlink_codex(&db, first_foreshadow_id.clone(), local_codex_id.clone(), 1)
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
            first_foreshadow_id.clone(),
            foreign_codex_id.clone(),
            2,
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

        let setup_omitted: ForeshadowSetupPatch =
            serde_json::from_value(serde_json::json!({ "baseVersion": 0 }))
                .expect("deserialize omitted setup patch");
        assert!(setup_omitted.strength.is_none());
        assert!(setup_omitted.ai_reasoning.is_none());
        assert!(setup_omitted.last_evaluated_at.is_none());

        let setup_cleared: ForeshadowSetupPatch = serde_json::from_value(serde_json::json!({
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

        let stale_delete = delete(
            &db,
            foreshadow_id.clone(),
            project_id,
            0,
            "stale-window".to_string(),
        )
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
        assert_eq!(journal[0]["count"], 0);
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
        link_codex(&db, linked_id.clone(), codex_id.clone(), 0).expect("link local root");
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
                base_version: 0,
                strength: Some(Some("weak".to_string())),
                ai_strength: None,
                ai_reasoning: None,
                is_orphan: None,
                last_evaluated_at: None,
            },
        )
        .expect_err("stale setup update must conflict");
        link_codex(&db, foreshadow_id.clone(), codex_id.clone(), 0)
            .expect_err("stale link must conflict and roll back");
        save_anchors_for_scene(
            &db,
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
        )
        .expect_err("stale anchor save must conflict and roll back");
        resolve_orphan(
            &db,
            OrphanResolvePayload {
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
            id: None,
            request_id: None,
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
            id: Some("foreshadow-entity-1".to_string()),
            request_id: Some("foreshadow-ui-request-1".to_string()),
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

        delete(
            &db,
            "foreshadow-entity-1".to_string(),
            proj.clone(),
            0,
            "fixture-session".to_string(),
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
            id: Some("foreshadow-entity-1".to_string()),
            request_id: Some("foreshadow-history-restore-1".to_string()),
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
    fn create_request_id_without_entity_id_replays_the_same_generated_entity() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            id: None,
            request_id: Some("foreshadow-request-only".to_string()),
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
            id: Some("foreshadow-payoff-validation".to_string()),
            request_id: Some("foreshadow-payoff-validation".to_string()),
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
            id: Some("foreshadow-payoff-range".to_string()),
            request_id: Some("foreshadow-payoff-range".to_string()),
            payoff_scene_id: Some(local_scene_id),
            payoff_from_pos: Some(9),
            payoff_to_pos: Some(3),
            ..base
        };
        let error = create(&db, invalid_range).expect_err("invalid payoff range");
        assert!(error.to_string().contains("0 <= from <= to"));
    }

    #[test]
    fn update_rejects_a_cross_project_payoff_scene() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow(&db, &project_id);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let patch = ForeshadowPatch {
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
    fn create_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            id: None,
            request_id: None,
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
            setup_create_ai_input(&setup_id, &other_foreshadow_id, &original_scene_id, 10, 20),
        )
        .expect_err("existing setup id must not be rebound to another foreshadow");
        assert!(foreshadow_error.to_string().contains("different anchor"));

        let scene_error = setup_create_ai(
            &db,
            setup_create_ai_input(&setup_id, &original_foreshadow_id, &other_scene_id, 10, 20),
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
            setup_create_ai_input(&duplicate_id, &foreshadow_id, &scene_id, 1, 5),
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
            setup_create_ai_input(&duplicate_id, &foreshadow_id, &scene_id, 6, 10),
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
            setup_create_ai_input(&duplicate_id, &foreshadow_id, &scene_id, 11, 15),
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
        let payload = OrphanResolvePayload {
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
        save_anchors_for_scene(
            &db,
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
        save_anchors_for_scene(
            &db,
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
        save_anchors_for_scene(
            &db,
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

        let rows = save_anchors_for_scene(
            &db,
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

        let unchanged = save_anchors_for_scene(
            &db,
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

        let error = save_anchors_for_scene(
            &db,
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
            let error = save_anchors_for_scene(
                &db,
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
            let error = save_anchors_for_scene(
                &db,
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

        let error = save_anchors_for_scene(
            &db,
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

        let mismatch = save_anchors_for_scene(
            &db,
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

        let error = save_anchors_for_scene(
            &db,
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

        save_anchors_for_scene(
            &db,
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
        save_anchors_for_scene(&db, scene.clone(), vec![], vec![], base_versions(&[]), 50).unwrap();

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
        save_anchors_for_scene(
            &db,
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
