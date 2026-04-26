mod ai;
mod codex_matching;
mod database;
mod lint_logging;
mod workspace;

use codex_matching::CodexMatcherState;
use database::Database;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use workspace::GlobalSettings;

/// AtomicBool flag to request aborting an in-progress chat stream.
struct StreamAbortFlag {
    flag: Arc<std::sync::atomic::AtomicBool>,
}

/// AtomicBool flag to request aborting an in-progress inline-AI stream.
/// Kept separate from `StreamAbortFlag` so that aborting one does not affect the other
/// when Chat and inline AI are streaming simultaneously.
struct InlineAiAbortFlag {
    flag: Arc<std::sync::atomic::AtomicBool>,
}

/// Holds the `tracing-appender` worker guard so the non-blocking writer
/// keeps draining for the lifetime of the Tauri app. Dropping this
/// flushes pending log lines synchronously.
struct LogGuard(#[allow(dead_code)] tracing_appender::non_blocking::WorkerGuard);

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
struct QueryResult {
    rows: Vec<serde_json::Map<String, Value>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowCreatePayload {
    project_id: String,
    title: String,
    intent: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowPatch {
    title: Option<String>,
    intent: Option<String>,
    notes: Option<String>,
    payoff_scene_id: Option<String>,
    payoff_from_pos: Option<i64>,
    payoff_to_pos: Option<i64>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowFilter {
    label: Option<String>,
    include_abandoned: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrphanResolvePayload {
    setup_id: String,
    action: String,
    scene_id: Option<String>,
    from_pos: Option<i64>,
    to_pos: Option<i64>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupAnchorInput {
    id: String,
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayoffAnchorInput {
    foreshadow_id: String,
    scene_id: String,
    from_pos: i64,
    to_pos: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AnchorMarkOutput {
    from: i64,
    to: i64,
    mark_name: String,
    attrs: Value,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowProposeRequest {
    intent: String,
    payoff_scene_id: String,
    payoff_excerpt: String,
    past_scenes: Vec<ForeshadowProposeScene>,
    related_codex: Vec<ForeshadowProposeCodex>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowProposeScene {
    scene_id: String,
    title: String,
    excerpt: String,
    order_index: i64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeshadowProposeCodex {
    id: String,
    name: String,
    summary: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ForeshadowProposedSetup {
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
struct ForeshadowProposeResponse {
    candidates: Vec<ForeshadowProposedSetup>,
}

/// Holds the currently-open workspace's DB.
/// Wrapped in Option so it can be None before a workspace is opened.
struct ActiveWorkspace {
    db: Database,
    #[allow(dead_code)]
    path: PathBuf,
}

struct WorkspaceState {
    inner: Mutex<Option<ActiveWorkspace>>,
}

/// Path to the global settings file in AppData.
struct GlobalSettingsPath {
    path: PathBuf,
}

/// Path to the AI settings file in AppData.
struct AiSettingsPath {
    path: PathBuf,
}

// --- Workspace commands ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
}

#[tauri::command]
fn get_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
) -> Result<GlobalSettings, AppError> {
    Ok(workspace::read_global_settings(&gs_path.path))
}

#[tauri::command]
fn save_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    settings: GlobalSettings,
) -> Result<(), AppError> {
    workspace::write_global_settings(&gs_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
fn validate_workspace_path(path: String) -> bool {
    let p = PathBuf::from(&path);
    p.exists() && p.is_dir() && p.join("grimodex.db").exists()
}

#[tauri::command]
fn open_workspace(
    ws_state: tauri::State<'_, WorkspaceState>,
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    path: String,
) -> Result<OpenWorkspaceResult, AppError> {
    let ws_path = PathBuf::from(&path);
    std::fs::create_dir_all(&ws_path).map_err(|e| anyhow::anyhow!(e))?;

    let is_existing = workspace::is_existing_workspace(&ws_path);

    // Initialize workspace metadata
    let uuid_str = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    workspace::ensure_workspace_meta(&ws_path, &uuid_str, &now)?;

    // Open database
    let db_path = ws_path.join("grimodex.db");
    let database = Database::new(&db_path)?;
    database.migrate()?;

    // Set as active workspace
    let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    *inner = Some(ActiveWorkspace {
        db: database,
        path: ws_path,
    });

    // Update global settings
    let mut settings = workspace::read_global_settings(&gs_path.path);
    let now = chrono::Utc::now().to_rfc3339();
    workspace::touch_recent_workspace(&mut settings, &path, &now);
    workspace::write_global_settings(&gs_path.path, &settings)?;

    let name = workspace::workspace_name(&path);
    Ok(OpenWorkspaceResult { name, is_existing })
}

// --- Existing DB/content commands (now workspace-aware) ---

fn with_db<T>(
    ws_state: &tauri::State<'_, WorkspaceState>,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> Result<T, AppError> {
    let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let ws = inner
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No workspace is open"))?;
    Ok(f(&ws.db)?)
}

#[tauri::command]
fn db_execute(
    ws_state: tauri::State<'_, WorkspaceState>,
    sql: String,
    params: Vec<Value>,
    method: String,
) -> Result<QueryResult, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute(&sql, &params, &method)?;
        Ok(QueryResult { rows })
    })
}

#[tauri::command]
fn db_execute_batch(
    ws_state: tauri::State<'_, WorkspaceState>,
    statements: Vec<database::BatchStatement>,
) -> Result<QueryResult, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute_batch_tx(&statements)?;
        Ok(QueryResult { rows })
    })
}

// --- Foreshadow commands ---

#[tauri::command]
fn foreshadow_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: ForeshadowCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        let now = chrono::Utc::now().timestamp_millis();
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, notes, payoff_scene_id, payoff_from_pos, payoff_to_pos, payoff_confirmed, abandoned, created_at, updated_at)
             VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(payload.project_id),
                Value::String(payload.title),
                payload.intent.map(Value::String).unwrap_or(Value::Null),
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
        Ok(rows.first().cloned().map(Value::Object).unwrap_or(Value::Null))
    })
}

#[tauri::command]
fn foreshadow_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: ForeshadowPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "UPDATE foreshadows
             SET title = COALESCE(?, title),
                 intent = COALESCE(?, intent),
                 notes = COALESCE(?, notes),
                 payoff_scene_id = COALESCE(?, payoff_scene_id),
                 payoff_from_pos = COALESCE(?, payoff_from_pos),
                 payoff_to_pos = COALESCE(?, payoff_to_pos),
                 payoff_confirmed = COALESCE(?, payoff_confirmed),
                 abandoned = COALESCE(?, abandoned),
                 updated_at = ?
             WHERE id = ?",
            &[
                patch.title.map(Value::String).unwrap_or(Value::Null),
                patch.intent.map(Value::String).unwrap_or(Value::Null),
                patch.notes.map(Value::String).unwrap_or(Value::Null),
                patch
                    .payoff_scene_id
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                patch
                    .payoff_from_pos
                    .map(|v| Value::Number(v.into()))
                    .unwrap_or(Value::Null),
                patch
                    .payoff_to_pos
                    .map(|v| Value::Number(v.into()))
                    .unwrap_or(Value::Null),
                patch
                    .payoff_confirmed
                    .map(Value::Bool)
                    .unwrap_or(Value::Null),
                patch
                    .abandoned
                    .map(Value::Bool)
                    .unwrap_or(Value::Null),
                Value::Number(now.into()),
                Value::String(id.clone()),
            ],
            "run",
        )?;
        let rows = db.execute(
            "SELECT * FROM foreshadows WHERE id = ?",
            &[Value::String(id)],
            "get",
        )?;
        Ok(rows.first().cloned().map(Value::Object).unwrap_or(Value::Null))
    })
}

#[tauri::command]
fn foreshadow_delete(ws_state: tauri::State<'_, WorkspaceState>, id: String) -> Result<(), AppError> {
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
fn foreshadow_list(
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
fn foreshadow_get(ws_state: tauri::State<'_, WorkspaceState>, id: String) -> Result<Value, AppError> {
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
fn foreshadow_link_codex(
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
fn foreshadow_unlink_codex(
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
fn foreshadow_set_setup_strength(
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

#[tauri::command]
fn foreshadow_resolve_orphan(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: OrphanResolvePayload,
) -> Result<Option<String>, AppError> {
    with_db(&ws_state, |db| {
        let now = chrono::Utc::now().timestamp_millis();
        match payload.action.as_str() {
            "reanchor" => {
                db.execute(
                    "UPDATE foreshadow_setups
                     SET scene_id = ?, from_pos = ?, to_pos = ?, is_orphan = 0, updated_at = ?
                     WHERE id = ?",
                    &[
                        payload.scene_id.map(Value::String).unwrap_or(Value::Null),
                        payload
                            .from_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
                        payload
                            .to_pos
                            .map(|v| Value::Number(v.into()))
                            .unwrap_or(Value::Null),
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
                db.execute(
                    "INSERT INTO foreshadow_setups
                     (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength, ai_strength, ai_reasoning, attribution, ai_rationale, last_evaluated_at, is_orphan, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, 'inserted_new', ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                    &[
                        Value::String(new_id.clone()),
                        existing.get("foreshadow_id").cloned().unwrap_or(Value::Null),
                        payload.scene_id.map(Value::String).unwrap_or(Value::Null),
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
                        existing.get("attribution").cloned().unwrap_or(Value::String("human".to_string())),
                        existing.get("ai_rationale").cloned().unwrap_or(Value::Null),
                        existing
                            .get("last_evaluated_at")
                            .cloned()
                            .unwrap_or(Value::Null),
                        Value::Number(now.into()),
                        Value::Number(now.into()),
                    ],
                    "run",
                )?;
                db.execute(
                    "DELETE FROM foreshadow_setups WHERE id = ?",
                    &[Value::String(payload.setup_id)],
                    "run",
                )?;
                Ok(Some(new_id))
            }
            _ => Ok(None),
        }
    })
}

#[tauri::command]
fn foreshadow_save_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
    setups: Vec<SetupAnchorInput>,
    payoffs: Vec<PayoffAnchorInput>,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
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
            statements.push(database::BatchStatement {
                sql: "UPDATE foreshadow_setups SET is_orphan = 1, updated_at = ? WHERE scene_id = ?"
                    .to_string(),
                params: vec![Value::Number(now.into()), Value::String(scene_id.clone())],
                method: "run".to_string(),
            });
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
    })
}

#[tauri::command]
fn foreshadow_load_anchors_for_scene(
    ws_state: tauri::State<'_, WorkspaceState>,
    scene_id: String,
) -> Result<Vec<AnchorMarkOutput>, AppError> {
    with_db(&ws_state, |db| {
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
    })
}

#[tauri::command]
async fn foreshadow_propose_past_setups(
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
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking: None,
        effort: None,
        reasoning_enabled: None,
        reasoning_effort: None,
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

    let parsed = serde_json::from_str::<ForeshadowProposeResponse>(&text)
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

    Ok(parsed)
}

// --- FTS commands ---

#[tauri::command]
fn fts_optimize(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_optimize())
}

#[tauri::command]
fn fts_rebuild(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_rebuild())
}

#[tauri::command]
fn fts_search(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    query: String,
    scope: String,
    limit: u32,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        db.search_fts(&project_id, &query, &scope, limit)
    })
}

// --- Integrity commands ---

#[tauri::command]
fn integrity_check(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.integrity_check())
}

#[tauri::command]
fn repair_integrity(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.repair_integrity())
}

// --- Chat commands ---

/// Ollama はAPIキー不要のため空文字を返す。それ以外は設定済みキーを要求する。
fn resolve_api_key(provider: &ai::AiProvider) -> anyhow::Result<String> {
    if matches!(provider, ai::AiProvider::Ollama) {
        return Ok(String::new());
    }
    ai::get_api_key(provider)?
        .ok_or_else(|| anyhow::anyhow!("No API key configured for {}", provider))
}

#[derive(serde::Deserialize)]
struct ChatMessagePayload {
    role: String,
    content: String,
}

#[tauri::command]
async fn send_chat_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };
    let result = ai::send_chat(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
    )
    .await?;
    Ok(result)
}

// --- Stream abort command ---

#[tauri::command]
fn abort_chat_stream(abort_flag: tauri::State<'_, StreamAbortFlag>) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

// --- Streaming chat command ---

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_chat_message_stream(
    ai_path: tauri::State<'_, AiSettingsPath>,
    abort_flag: tauri::State<'_, StreamAbortFlag>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<(), AppError> {
    // Reset abort flag before starting
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        app_handle.clone(),
        "chat",
    )
    .await;

    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "chat:stream-error",
            serde_json::json!({ "message": e.to_string() }),
        );
        return Err(AppError::Anyhow(e));
    }

    Ok(())
}

// --- Inline AI streaming commands ---

#[tauri::command]
fn abort_inline_ai_stream(abort_flag: tauri::State<'_, InlineAiAbortFlag>) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_inline_ai_stream(
    ai_path: tauri::State<'_, AiSettingsPath>,
    abort_flag: tauri::State<'_, InlineAiAbortFlag>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        app_handle.clone(),
        "inline-ai",
    )
    .await;

    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "inline-ai:stream-error",
            serde_json::json!({ "message": e.to_string() }),
        );
        return Err(AppError::Anyhow(e));
    }

    Ok(())
}

// --- Agent / Tool Use command ---

#[tauri::command]
async fn send_agent_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ai::AgentMessage>,
    tools: Vec<ai::AgentToolDef>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };
    let result = ai::send_chat_with_tools(&params, &messages, &tools).await?;
    Ok(result)
}

// --- AI settings commands ---

#[tauri::command]
fn get_ai_settings(ai_path: tauri::State<'_, AiSettingsPath>) -> Result<ai::AiSettings, AppError> {
    Ok(ai::read_ai_settings(&ai_path.path))
}

#[tauri::command]
fn save_ai_settings(
    ai_path: tauri::State<'_, AiSettingsPath>,
    settings: ai::AiSettings,
) -> Result<(), AppError> {
    ai::write_ai_settings(&ai_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
fn save_api_key(provider: ai::AiProvider, key: String) -> Result<(), AppError> {
    ai::save_api_key(&provider, &key)?;
    Ok(())
}

#[tauri::command]
fn get_api_key(provider: ai::AiProvider) -> Result<Option<String>, AppError> {
    Ok(ai::get_api_key(&provider)?)
}

#[tauri::command]
fn delete_api_key(provider: ai::AiProvider) -> Result<(), AppError> {
    ai::delete_api_key(&provider)?;
    Ok(())
}

#[tauri::command]
async fn list_ai_models(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
) -> Result<Vec<ai::AiModel>, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = ai::get_api_key(&provider)?.unwrap_or_default();
    let models = ai::fetch_models(&provider, &api_key, &settings.ollama_endpoint).await?;
    Ok(models)
}

/// Deterministic text linter entry point (see `grimodex_lint::lint`).
///
/// Accepts the pre-serialised `LintBlock[]` from the frontend position map
/// and returns diagnostics in scene-wide UTF-16 offsets.
#[tauri::command]
fn lint_text(
    blocks: Vec<grimodex_lint::LintBlock>,
    language: String,
    scope: grimodex_lint::LintScope,
    config: grimodex_lint::LintConfig,
    disables: Option<Vec<grimodex_lint::DisableDirective>>,
) -> Result<grimodex_lint::LintResponse, grimodex_lint::LintError> {
    let lang = match language.as_str() {
        "ja" => grimodex_lint::Language::Japanese,
        "en" => grimodex_lint::Language::English,
        other => return Err(grimodex_lint::LintError::InvalidLanguage(other.to_string())),
    };
    let disables = disables.unwrap_or_default();
    grimodex_lint::lint(&blocks, lang, scope, &config, &disables)
}

#[tauri::command]
async fn test_ai_connection(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
    model: String,
) -> Result<String, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&provider)?;
    let result =
        ai::test_connection(&provider, &model, &api_key, &settings.ollama_endpoint).await?;
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Daily-rotating file log under `~/.grimodex/logs/lint-tauri-*.log`
    // plus stderr. The guard must outlive `tauri::Builder::run` so file
    // writes are flushed; stash it on the manager state.
    let log_guard = lint_logging::init_tauri_logging();

    let mut builder = tauri::Builder::default();
    if let Some(guard) = log_guard {
        builder = builder.manage(LogGuard(guard));
    }
    builder
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();

            // Global settings path (stays in AppData)
            let gs_path = app_dir.join("global-settings.json");
            app.manage(GlobalSettingsPath { path: gs_path });

            // AI settings path (stays in AppData)
            let ai_path = app_dir.join("ai-settings.json");
            app.manage(AiSettingsPath { path: ai_path });

            // Workspace state starts empty — frontend will call open_workspace
            app.manage(WorkspaceState {
                inner: Mutex::new(None),
            });

            // Codex matcher state (rebuilt on demand via codex_rebuild_matcher)
            app.manage(CodexMatcherState {
                inner: Mutex::new(None),
            });

            // Stream abort flag
            app.manage(StreamAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            // Inline AI abort flag (separate from chat's flag)
            app.manage(InlineAiAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_global_settings,
            save_global_settings,
            validate_workspace_path,
            open_workspace,
            db_execute,
            db_execute_batch,
            get_ai_settings,
            save_ai_settings,
            save_api_key,
            get_api_key,
            delete_api_key,
            list_ai_models,
            test_ai_connection,
            send_chat_message,
            send_chat_message_stream,
            abort_chat_stream,
            send_inline_ai_stream,
            abort_inline_ai_stream,
            send_agent_message,
            foreshadow_create,
            foreshadow_update,
            foreshadow_delete,
            foreshadow_list,
            foreshadow_get,
            foreshadow_link_codex,
            foreshadow_unlink_codex,
            foreshadow_set_setup_strength,
            foreshadow_resolve_orphan,
            foreshadow_save_anchors_for_scene,
            foreshadow_load_anchors_for_scene,
            foreshadow_propose_past_setups,
            fts_optimize,
            fts_rebuild,
            fts_search,
            integrity_check,
            repair_integrity,
            codex_matching::codex_rebuild_matcher,
            codex_matching::codex_match_text,
            lint_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
