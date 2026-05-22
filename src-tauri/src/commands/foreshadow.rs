//! Foreshadow Tauri commands and helpers.

use serde_json::Value;

use crate::ai;
use crate::database;

use super::ai::resolve_api_key;
use super::{with_db, AiSettingsPath, AppError, WorkspaceState};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowCreatePayload {
    project_id: String,
    title: String,
    intent: Option<String>,
    load_bearing: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowPatch {
    title: Option<String>,
    intent: Option<Option<String>>,
    notes: Option<Option<String>>,
    payoff_scene_id: Option<Option<String>>,
    payoff_from_pos: Option<Option<i64>>,
    payoff_to_pos: Option<Option<i64>>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
    secret: Option<bool>,
    load_bearing: Option<Option<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowFilter {
    label: Option<String>,
    include_abandoned: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OrphanResolvePayload {
    setup_id: String,
    action: String,
    scene_id: Option<String>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetupAnchorInput {
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PayoffAnchorInput {
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnchorMarkOutput {
    from: i64,
    to: i64,
    mark_name: String,
    attrs: Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowProposeRequest {
    intent: String,
    payoff_scene_id: String,
    payoff_excerpt: String,
    past_scenes: Vec<ForeshadowProposeScene>,
    related_codex: Vec<ForeshadowProposeCodex>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowProposeScene {
    scene_id: String,
    title: String,
    excerpt: String,
    order_index: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowProposeCodex {
    id: String,
    name: String,
    summary: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowProposedSetup {
    scene_id: String,
    kind: String,
    existing_excerpt: Option<String>,
    from_pos_hint: Option<i64>,
    to_pos_hint: Option<i64>,
    suggested_insertion_point: Option<String>,
    suggested_text: Option<String>,
    rationale: String,
    predicted_strength: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowProposeResponse {
    candidates: Vec<ForeshadowProposedSetup>,
}

// ── AI 監査パス 型定義 ────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditScene {
    scene_id: String,
    title: String,
    body_text: String,
    order_index: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditExistingForeshadow {
    id: String,
    title: String,
    intent: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditCodex {
    id: String,
    name: String,
    summary: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditRequest {
    chapter_id: String,
    scenes: Vec<ForeshadowAuditScene>,
    existing_foreshadows: Vec<ForeshadowAuditExistingForeshadow>,
    related_codex: Vec<ForeshadowAuditCodex>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditCandidate {
    suggested_title: String,
    suggested_intent: String,
    evidence_scene_id: String,
    evidence_excerpt: String,
    rationale: String,
    confidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    similar_to_existing_foreshadow_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForeshadowAuditResponse {
    candidates: Vec<ForeshadowAuditCandidate>,
}
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

fn foreshadow_create_impl(
    db: &database::Database,
    payload: ForeshadowCreatePayload,
) -> anyhow::Result<Value> {
    validate_load_bearing(payload.load_bearing.as_deref())?;
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO foreshadows
         (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned, secret, load_bearing, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, 1, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(payload.project_id),
            Value::String(payload.title),
            payload.intent.map(Value::String).unwrap_or(Value::Null),
            payload.load_bearing.map(Value::String).unwrap_or(Value::Null),
            Value::Number(now.into()),
            Value::Number(now.into()),
        ],
        "run",
    )?;
    let rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?;
    Ok(rows
        .first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) fn foreshadow_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: ForeshadowCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| foreshadow_create_impl(db, payload))
}

fn foreshadow_update_impl(
    db: &database::Database,
    id: String,
    patch: ForeshadowPatch,
) -> anyhow::Result<Value> {
    if let Some(ref lb) = patch.load_bearing {
        validate_load_bearing(lb.as_deref())?;
    }
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
            "SELECT * FROM foreshadows WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?;
        return Ok(rows
            .first()
            .cloned()
            .map(Value::Object)
            .unwrap_or(Value::Null));
    }

    sets.push("updated_at = ?");
    params.push(Value::Number(now.into()));
    params.push(Value::String(id.clone()));

    let sql = format!("UPDATE foreshadows SET {} WHERE id = ?", sets.join(", "));
    db.execute(&sql, &params, "run")?;
    let rows = db.execute(
        "SELECT * FROM foreshadows WHERE id = ?",
        &[Value::String(id)],
        "get",
    )?;
    Ok(rows
        .first()
        .cloned()
        .map(Value::Object)
        .unwrap_or(Value::Null))
}

#[tauri::command]
pub(crate) fn foreshadow_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: ForeshadowPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| foreshadow_update_impl(db, id, patch))
}

#[tauri::command]
pub(crate) fn foreshadow_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM foreshadows WHERE id = ?",
            &[Value::String(id)],
            "run",
        )?;
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn foreshadow_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    filter: Option<ForeshadowFilter>,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        let include_abandoned = filter
            .as_ref()
            .and_then(|f| f.include_abandoned)
            .unwrap_or(true);
        let rows = if include_abandoned {
            db.execute(
                "SELECT * FROM foreshadows WHERE project_id = ? ORDER BY updated_at DESC",
                &[Value::String(project_id)],
                "all",
            )?
        } else {
            db.execute(
                "SELECT * FROM foreshadows WHERE project_id = ? AND abandoned = 0 ORDER BY updated_at DESC",
                &[Value::String(project_id)],
                "all",
            )?
        };

        let label_filter = filter.and_then(|f| f.label);
        let mut values: Vec<Value> = rows.into_iter().map(Value::Object).collect();
        if let Some(label) = label_filter {
            values.retain(|row| {
                let obj = match row {
                    Value::Object(obj) => obj,
                    _ => return false,
                };
                let payoff_confirmed = obj
                    .get("payoff_confirmed")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0)
                    == 1;
                let abandoned = obj.get("abandoned").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
                match label.as_str() {
                    "abandoned" => abandoned,
                    "paid" => !abandoned && payoff_confirmed,
                    "planned" => !abandoned && !payoff_confirmed,
                    _ => true,
                }
            });
        }
        Ok(values)
    })
}

#[tauri::command]
pub(crate) fn foreshadow_get(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
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
    })
}

#[tauri::command]
pub(crate) fn foreshadow_link_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
    codex_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "INSERT OR IGNORE INTO foreshadow_codex_links (foreshadow_id, codex_entry_id) VALUES (?, ?)",
            &[Value::String(foreshadow_id), Value::String(codex_id)],
            "run",
        )?;
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn foreshadow_unlink_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
    codex_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM foreshadow_codex_links WHERE foreshadow_id = ? AND codex_entry_id = ?",
            &[Value::String(foreshadow_id), Value::String(codex_id)],
            "run",
        )?;
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn foreshadow_list_linked_codex(
    ws_state: tauri::State<'_, WorkspaceState>,
    foreshadow_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute(
            "SELECT ce.* FROM codex_entries ce \
             JOIN foreshadow_codex_links fcl ON ce.id = fcl.codex_entry_id \
             WHERE fcl.foreshadow_id = ? \
             ORDER BY ce.name ASC",
            &[Value::String(foreshadow_id)],
            "all",
        )?;
        Ok(rows.into_iter().map(Value::Object).collect())
    })
}

#[tauri::command]
pub(crate) fn foreshadow_set_setup_strength(
    ws_state: tauri::State<'_, WorkspaceState>,
    setup_id: String,
    strength: Option<String>,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "UPDATE foreshadow_setups SET strength = ?, updated_at = ? WHERE id = ?",
            &[
                strength.map(Value::String).unwrap_or(Value::Null),
                Value::Number(now.into()),
                Value::String(setup_id),
            ],
            "run",
        )?;
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) fn foreshadow_setup_create_ai(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
    kind: String,
    strength: Option<String>,
    ai_strength: Option<String>,
    attribution: String,
    ai_rationale: Option<String>,
    ai_reasoning: Option<String>,
    last_evaluated_at: Option<i64>,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadow_setups
             (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength,
              attribution, ai_rationale, ai_reasoning, last_evaluated_at, is_orphan, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               from_pos   = excluded.from_pos,
               to_pos     = excluded.to_pos,
               is_orphan  = 0,
               updated_at = excluded.updated_at",
            &[
                Value::String(id),
                Value::String(foreshadow_id),
                Value::String(scene_id),
                Value::Number(from_pos.into()),
                Value::Number(to_pos.into()),
                Value::String(kind),
                strength.map(Value::String).unwrap_or(Value::Null),
                ai_strength.map(Value::String).unwrap_or(Value::Null),
                Value::String(attribution),
                ai_rationale.map(Value::String).unwrap_or(Value::Null),
                ai_reasoning.map(Value::String).unwrap_or(Value::Null),
                last_evaluated_at.map(|v| Value::Number(v.into())).unwrap_or(Value::Null),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )?;
        Ok(())
    })
}

fn resolve_orphan_impl(
    db: &database::Database,
    payload: OrphanResolvePayload,
) -> anyhow::Result<Option<String>> {
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
            db.execute(
                "UPDATE foreshadow_setups
                 SET scene_id = ?, from_pos = ?, to_pos = ?, is_orphan = 0, updated_at = ?
                 WHERE id = ?",
                &[
                    Value::String(scene_id),
                    Value::Number(from_pos.into()),
                    Value::Number(to_pos.into()),
                    Value::Number(now.into()),
                    Value::String(payload.setup_id),
                ],
                "run",
            )?;
            Ok(None)
        }
        "delete" => {
            db.execute(
                "DELETE FROM foreshadow_setups WHERE id = ?",
                &[Value::String(payload.setup_id)],
                "run",
            )?;
            Ok(None)
        }
        "reinsert" => {
            let rows = db.execute(
                "SELECT foreshadow_id, strength, ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at
                 FROM foreshadow_setups WHERE id = ?",
                &[Value::String(payload.setup_id.clone())],
                "get",
            )?;
            let Some(existing) = rows.first() else {
                return Ok(None);
            };
            let new_id = uuid::Uuid::new_v4().to_string();
            // INSERT + DELETE must be atomic to prevent duplicate rows on partial failure.
            db.execute_batch_tx(&[
                database::BatchStatement {
                    sql: "INSERT INTO foreshadow_setups
                          (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at, is_orphan, created_at, updated_at)
                          VALUES (?, ?, ?, ?, ?, 'inserted_new', ?, ?, ?, ?, ?, ?, 0, ?, ?)"
                        .to_string(),
                    params: vec![
                        Value::String(new_id.clone()),
                        existing.get("foreshadow_id").cloned().unwrap_or(Value::Null),
                        payload
                            .scene_id
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                        payload
                            .from_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
                        payload
                            .to_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
                        existing.get("strength").cloned().unwrap_or(Value::Null),
                        existing.get("ai_strength").cloned().unwrap_or(Value::Null),
                        existing.get("ai_reasoning").cloned().unwrap_or(Value::Null),
                        existing
                            .get("attribution")
                            .cloned()
                            .unwrap_or_else(|| Value::String("human".to_string())),
                        existing.get("ai_rationale").cloned().unwrap_or(Value::Null),
                        existing
                            .get("last_evaluated_at")
                            .cloned()
                            .unwrap_or(Value::Null),
                        Value::Number(now.into()),
                        Value::Number(now.into()),
                    ],
                    method: "run".to_string(),
                },
                database::BatchStatement {
                    sql: "DELETE FROM foreshadow_setups WHERE id = ?".to_string(),
                    params: vec![Value::String(payload.setup_id)],
                    method: "run".to_string(),
                },
            ])?;
            Ok(Some(new_id))
        }
        _ => Ok(None),
    }
}

#[tauri::command]
pub(crate) fn foreshadow_resolve_orphan(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: OrphanResolvePayload,
) -> Result<Option<String>, AppError> {
    with_db(&ws_state, |db| resolve_orphan_impl(db, payload))
}

fn save_anchors_for_scene_impl(
    db: &database::Database,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
    doc_content_size: i64,
) -> anyhow::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut statements: Vec<database::BatchStatement> = Vec::new();

    for s in &setups {
        statements.push(database::BatchStatement {
            sql: "INSERT INTO foreshadow_setups
                  (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution, is_orphan, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', 0, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET
                    from_pos   = excluded.from_pos,
                    to_pos     = excluded.to_pos,
                    is_orphan  = 0,
                    updated_at = excluded.updated_at"
                .to_string(),
            params: vec![
                Value::String(s.id.clone()),
                Value::String(s.foreshadow_id.clone()),
                Value::String(s.scene_id.clone()),
                Value::Number(s.from_pos.into()),
                Value::Number(s.to_pos.into()),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            method: "run".to_string(),
        });
    }

    for p in &payoffs {
        statements.push(database::BatchStatement {
            sql: "UPDATE foreshadows
                  SET payoff_scene_id = ?, payoff_from_pos = ?, payoff_to_pos = ?, updated_at = ?
                  WHERE id = ?"
                .to_string(),
            params: vec![
                Value::String(p.scene_id.clone()),
                Value::Number(p.from_pos.into()),
                Value::Number(p.to_pos.into()),
                Value::Number(now.into()),
                Value::String(p.foreshadow_id.clone()),
            ],
            method: "run".to_string(),
        });
    }

    if setups.is_empty() {
        // Guard: skip bulk-orphan when the document has content (doc_content_size > 2).
        // ProseMirror empty doc has size=2 (root+paragraph). A non-empty doc with zero
        // extracted setups could indicate an extraction bug; conservatively skip to
        // prevent accidental data loss. Users can reload or manually clean orphans.
        if doc_content_size <= 2 {
            statements.push(database::BatchStatement {
                sql:
                    "UPDATE foreshadow_setups SET is_orphan = 1, updated_at = ? WHERE scene_id = ?"
                        .to_string(),
                params: vec![Value::Number(now.into()), Value::String(scene_id.clone())],
                method: "run".to_string(),
            });
        }
    } else {
        let placeholders = std::iter::repeat_n("?", setups.len())
            .collect::<Vec<_>>()
            .join(", ");
        let mut params = vec![Value::Number(now.into()), Value::String(scene_id.clone())];
        params.extend(setups.iter().map(|s| Value::String(s.id.clone())));
        statements.push(database::BatchStatement {
            sql: format!(
                "UPDATE foreshadow_setups
                 SET is_orphan = 1, updated_at = ?
                 WHERE scene_id = ? AND id NOT IN ({placeholders})"
            ),
            params,
            method: "run".to_string(),
        });
    }

    if !statements.is_empty() {
        db.execute_batch_tx(&statements)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn foreshadow_save_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
    doc_content_size: i64,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        save_anchors_for_scene_impl(db, scene_id, setups, payoffs, doc_content_size)
    })
}

fn load_anchors_for_scene_impl(
    db: &database::Database,
    scene_id: String,
) -> anyhow::Result<Vec<AnchorMarkOutput>> {
    let setup_rows = db.execute(
        "SELECT id, foreshadow_id, from_pos, to_pos
         FROM foreshadow_setups
         WHERE scene_id = ? AND is_orphan = 0",
        &[Value::String(scene_id.clone())],
        "all",
    )?;
    let payoff_rows = db.execute(
        "SELECT id, payoff_from_pos, payoff_to_pos
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
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowSetup".to_string(),
            attrs: serde_json::json!({ "setupId": setup_id, "foreshadowId": foreshadow_id }),
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
        out.push(AnchorMarkOutput {
            from,
            to,
            mark_name: "foreshadowPayoff".to_string(),
            attrs: serde_json::json!({ "foreshadowId": foreshadow_id }),
        });
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn foreshadow_load_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
) -> Result<Vec<AnchorMarkOutput>, AppError> {
    let started = std::time::Instant::now();
    let result = with_db(&ws_state, |db| load_anchors_for_scene_impl(db, scene_id));
    let total_ms = started.elapsed().as_millis();
    if total_ms >= 50 {
        tracing::warn!("foreshadow_load_anchors_for_scene total={}ms", total_ms);
    }
    result
}

#[tauri::command]
pub(crate) async fn foreshadow_propose_past_setups(
    ai_path: tauri::State<'_, AiSettingsPath>,
    req: ForeshadowProposeRequest,
) -> Result<ForeshadowProposeResponse, AppError> {
    let scene_summary = req
        .past_scenes
        .iter()
        .take(30)
        .map(|scene| {
            format!(
                "- sceneId={}, title={}, order={}\n  excerpt: {}",
                scene.scene_id, scene.title, scene.order_index, scene.excerpt
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let codex_summary = req
        .related_codex
        .iter()
        .take(20)
        .map(|entry| format!("- {} ({}): {}", entry.name, entry.id, entry.summary))
        .collect::<Vec<_>>()
        .join("\n");

    let prompt = [
        "あなたは小説編集アシスタントです。",
        "回収シーンを成立させるために、過去シーンに置く setup 候補を提案してください。",
        "必ず JSON のみを返してください（前置き・解説禁止）。",
        "JSON 形式:",
        "{\"candidates\":[{\"sceneId\":\"...\",\"kind\":\"designated_existing|inserted_new\",\"existingExcerpt\":\"...\",\"fromPosHint\":1,\"toPosHint\":2,\"suggestedInsertionPoint\":\"...\",\"suggestedText\":\"...\",\"rationale\":\"...\",\"predictedStrength\":\"subtle|moderate|overt\"}]}",
        "",
        &format!("intent: {}", req.intent),
        &format!("payoffSceneId: {}", req.payoff_scene_id),
        &format!("payoffExcerpt: {}", req.payoff_excerpt),
        "",
        "[pastScenes]",
        if scene_summary.is_empty() { "(none)" } else { &scene_summary },
        "",
        "[relatedCodex]",
        if codex_summary.is_empty() { "(none)" } else { &codex_summary },
    ]
    .join("\n");

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = crate::commands::ai::build_ai_novelist_extra_body(&settings);
    let retry_429 = crate::commands::ai::should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking: None,
        effort: None,
        reasoning_enabled: None,
        reasoning_effort: None,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Chat,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments: None,
    };
    let response = ai::send_chat(&params, &[("user", prompt.as_str())]).await?;
    let text = response
        .blocks
        .iter()
        .filter_map(|b| match b {
            ai::ResponseBlock::Text { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut parsed = serde_json::from_str::<ForeshadowProposeResponse>(&text)
        .ok()
        .or_else(|| {
            let start = text.find('{')?;
            let end = text.rfind('}')?;
            if end <= start {
                return None;
            }
            serde_json::from_str::<ForeshadowProposeResponse>(&text[start..=end]).ok()
        })
        .unwrap_or(ForeshadowProposeResponse {
            candidates: Vec::new(),
        });

    // Reject candidates whose kind or predicted_strength are not in the allowed set.
    // Prevents prompt-injected garbage from reaching the frontend.
    parsed.candidates.retain(|c| {
        matches!(c.kind.as_str(), "designated_existing" | "inserted_new")
            && matches!(
                c.predicted_strength.as_str(),
                "subtle" | "moderate" | "overt"
            )
    });

    Ok(parsed)
}

#[tauri::command]
pub(crate) async fn foreshadow_audit_chapter(
    ai_path: tauri::State<'_, AiSettingsPath>,
    req: ForeshadowAuditRequest,
) -> Result<ForeshadowAuditResponse, AppError> {
    let non_empty_scenes: Vec<&ForeshadowAuditScene> = req
        .scenes
        .iter()
        .filter(|s| !s.body_text.trim().is_empty())
        .collect();

    if non_empty_scenes.is_empty() {
        return Ok(ForeshadowAuditResponse {
            candidates: Vec::new(),
        });
    }

    let scene_texts = non_empty_scenes
        .iter()
        .map(|s| {
            format!(
                "--- sceneId={}, title={}, order={} ---\n{}",
                s.scene_id, s.title, s.order_index, s.body_text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");

    let existing_list = if req.existing_foreshadows.is_empty() {
        "(なし)".to_string()
    } else {
        req.existing_foreshadows
            .iter()
            .map(|f| {
                format!(
                    "- id={}, title={}, intent={}",
                    f.id,
                    f.title,
                    f.intent.as_deref().unwrap_or("(未設定)")
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let codex_list = if req.related_codex.is_empty() {
        "(なし)".to_string()
    } else {
        req.related_codex
            .iter()
            .map(|e| format!("- {} ({}): {}", e.name, e.id, e.summary))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let _ = req.chapter_id; // used for context, not in prompt directly

    let prompt = [
        "あなたは小説編集アシスタントです。",
        "以下の章のシーン本文を読み、登録漏れの伏線候補を抽出してください。",
        "必ず JSON のみを返してください（前置き・解説禁止）。",
        "",
        "【ルール】",
        "- 本文に実際に書かれている描写・言及のみを根拠とする（推測・捏造禁止）",
        "- 「さりげない描写」「具体的なディテール」「繰り返される言及」「不自然な強調」を優先的に拾う",
        "- 既存伏線リストと意味が近い候補は similarToExistingForeshadowId にそのIDを入れる",
        "- confidence: 確信できない場合は low、中程度は medium、明らかな場合のみ high",
        "- 確信できない候補は提案しない（偽陽性を避ける）",
        "- 各候補に evidenceSceneId と evidenceExcerpt（本文からの直接引用、20〜80字）が必須",
        "",
        "{\"candidates\":[{\"suggestedTitle\":\"...\",\"suggestedIntent\":\"...\",\"evidenceSceneId\":\"...\",\"evidenceExcerpt\":\"...\",\"rationale\":\"...\",\"confidence\":\"low|medium|high\",\"similarToExistingForeshadowId\":\"(省略可)\"}]}",
        "",
        "[既存登録済み伏線（除外リスト）]",
        &existing_list,
        "",
        "[関連Codex]",
        &codex_list,
        "",
        "[シーン本文]",
        &scene_texts,
    ]
    .join("\n");

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = crate::commands::ai::build_ai_novelist_extra_body(&settings);
    let retry_429 = crate::commands::ai::should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking: None,
        effort: None,
        reasoning_enabled: None,
        reasoning_effort: None,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Chat,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments: None,
    };
    let response = ai::send_chat(&params, &[("user", prompt.as_str())]).await?;
    let text = response
        .blocks
        .iter()
        .filter_map(|b| match b {
            ai::ResponseBlock::Text { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");

    let mut parsed = serde_json::from_str::<ForeshadowAuditResponse>(&text)
        .ok()
        .or_else(|| {
            let start = text.find('{')?;
            let end = text.rfind('}')?;
            if end <= start {
                return None;
            }
            serde_json::from_str::<ForeshadowAuditResponse>(&text[start..=end]).ok()
        })
        .unwrap_or(ForeshadowAuditResponse {
            candidates: Vec::new(),
        });

    // confidence 値のバリデーション
    parsed
        .candidates
        .retain(|c| matches!(c.confidence.as_str(), "low" | "medium" | "high"));

    Ok(parsed)
}

// --- FTS commands ---
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_db() -> database::Database {
        let db = database::Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    fn insert_project(db: &database::Database) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Test')",
            &[Value::String(id.clone())],
            "run",
        )
        .expect("insert project");
        id
    }

    fn insert_foreshadow(db: &database::Database, project_id: &str) -> String {
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

    fn insert_scene(db: &database::Database, project_id: &str) -> String {
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

    fn insert_setup(
        db: &database::Database,
        foreshadow_id: &str,
        scene_id: &str,
        from_pos: i64,
        to_pos: i64,
        is_orphan: bool,
    ) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadow_setups
             (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution, is_orphan, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'designated_existing', 'human', ?, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(foreshadow_id.to_string()),
                Value::String(scene_id.to_string()),
                Value::Number(from_pos.into()),
                Value::Number(to_pos.into()),
                Value::Bool(is_orphan),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert setup");
        id
    }

    // ── foreshadow_update_impl ────────────────────────────────────────

    #[test]
    fn update_impl_no_fields_returns_existing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
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
        let result = foreshadow_update_impl(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["id"], Value::String(fid));
    }

    #[test]
    fn update_impl_single_field_updates_title() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
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
        let result = foreshadow_update_impl(&db, fid.clone(), patch).unwrap();
        assert_eq!(result["title"], Value::String("新タイトル".to_string()));
    }

    #[test]
    fn update_impl_null_clear_intent() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        // Set intent first
        let set_patch = ForeshadowPatch {
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
        foreshadow_update_impl(&db, fid.clone(), set_patch).unwrap();

        // Now clear it with Some(None)
        let clear_patch = ForeshadowPatch {
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
        let result = foreshadow_update_impl(&db, fid.clone(), clear_patch).unwrap();
        assert_eq!(result["intent"], Value::Null);
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
            project_id: proj,
            title: "T".to_string(),
            intent: None,
            load_bearing: Some("critical".to_string()),
        };
        let row = foreshadow_create_impl(&db, payload).unwrap();
        assert_eq!(row["load_bearing"], Value::String("critical".to_string()));
    }

    #[test]
    fn create_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let payload = ForeshadowCreatePayload {
            project_id: proj.clone(),
            title: "T".to_string(),
            intent: None,
            load_bearing: Some("required".to_string()),
        };
        let result = foreshadow_create_impl(&db, payload);
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
        let result = foreshadow_update_impl(&db, fid, patch).unwrap();
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
        foreshadow_update_impl(&db, fid.clone(), set_patch).unwrap();

        // Some(None) で NULL クリア
        let clear_patch = ForeshadowPatch {
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
        let result = foreshadow_update_impl(&db, fid, clear_patch).unwrap();
        assert_eq!(result["load_bearing"], Value::Null);
    }

    #[test]
    fn update_impl_rejects_invalid_load_bearing() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);

        let patch = ForeshadowPatch {
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
        let result = foreshadow_update_impl(&db, fid.clone(), patch);
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

    // ── resolve_orphan_impl ───────────────────────────────────────────

    #[test]
    fn resolve_orphan_reanchor_missing_scene_id_errors() {
        let db = test_db();
        let payload = OrphanResolvePayload {
            setup_id: "s-1".to_string(),
            action: "reanchor".to_string(),
            scene_id: None,
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let result = resolve_orphan_impl(&db, payload);
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
            action: "reanchor".to_string(),
            scene_id: Some("sc-1".to_string()),
            from_pos: None,
            to_pos: Some(20),
        };
        let result = resolve_orphan_impl(&db, payload);
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
            action: "reanchor".to_string(),
            scene_id: Some(new_scene.clone()),
            from_pos: Some(5),
            to_pos: Some(15),
        };
        resolve_orphan_impl(&db, payload).unwrap();

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
            action: "reinsert".to_string(),
            scene_id: Some(scene.clone()),
            from_pos: Some(10),
            to_pos: Some(20),
        };
        let new_id = resolve_orphan_impl(&db, payload).unwrap().unwrap();

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
            action: "reinsert".to_string(),
            scene_id: Some("sc".to_string()),
            from_pos: Some(1),
            to_pos: Some(5),
        };
        let result = resolve_orphan_impl(&db, payload).unwrap();
        assert!(result.is_none());
    }

    // ── save_anchors_for_scene_impl ───────────────────────────────────

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
            scene_id: scene.clone(),
            from_pos: 1,
            to_pos: 5,
        }];
        save_anchors_for_scene_impl(&db, scene.clone(), setups, vec![], 50).unwrap();

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
    fn save_anchors_bulk_orphan_skipped_when_doc_has_content() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        let sid = insert_setup(&db, &fid, &scene, 1, 5, false);

        // setups empty but doc has content (size > 2) → bulk orphan must be skipped
        save_anchors_for_scene_impl(&db, scene.clone(), vec![], vec![], 50).unwrap();

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
        save_anchors_for_scene_impl(&db, scene.clone(), vec![], vec![], 2).unwrap();

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

    // ── load_anchors_for_scene_impl ───────────────────────────────────

    #[test]
    fn load_anchors_skips_setup_with_zero_coords() {
        let db = test_db();
        let proj = insert_project(&db);
        let fid = insert_foreshadow(&db, &proj);
        let scene = insert_scene(&db, &proj);
        // Insert setup with from=0/to=0 (invalid coords)
        insert_setup(&db, &fid, &scene, 0, 0, false);

        let result = load_anchors_for_scene_impl(&db, scene.clone()).unwrap();
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

        let result = load_anchors_for_scene_impl(&db, scene.clone()).unwrap();
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

        let result = load_anchors_for_scene_impl(&db, scene.clone()).unwrap();
        assert!(result.is_empty(), "orphan setup must be excluded");
    }

    // ── candidate validation in propose ──────────────────────────────

    #[test]
    fn filter_proposed_candidates_invalid_kind() {
        let mut response = ForeshadowProposeResponse {
            candidates: vec![
                ForeshadowProposedSetup {
                    scene_id: "s1".to_string(),
                    kind: "designated_existing".to_string(),
                    existing_excerpt: None,
                    from_pos_hint: None,
                    to_pos_hint: None,
                    suggested_insertion_point: None,
                    suggested_text: None,
                    rationale: "ok".to_string(),
                    predicted_strength: "subtle".to_string(),
                },
                ForeshadowProposedSetup {
                    scene_id: "s2".to_string(),
                    kind: "INJECTED_JUNK".to_string(),
                    existing_excerpt: None,
                    from_pos_hint: None,
                    to_pos_hint: None,
                    suggested_insertion_point: None,
                    suggested_text: None,
                    rationale: "bad".to_string(),
                    predicted_strength: "subtle".to_string(),
                },
            ],
        };
        response.candidates.retain(|c| {
            matches!(c.kind.as_str(), "designated_existing" | "inserted_new")
                && matches!(
                    c.predicted_strength.as_str(),
                    "subtle" | "moderate" | "overt"
                )
        });
        assert_eq!(response.candidates.len(), 1);
        assert_eq!(response.candidates[0].scene_id, "s1");
    }
}
