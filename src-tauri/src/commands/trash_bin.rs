//! Trash bin Tauri commands.
//!
//! Phase 1 では文字屑のみ書き込まれる。`payload` / `preview_meta` は
//! 素の TEXT で JSON 文字列を保持し、フロント側で `JSON.parse` する。

use serde_json::Value;

use crate::database;

use super::{with_db, AppError, WorkspaceState};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashBinCreatePayload {
    project_id: String,
    kind: String,
    sub_kind: String,
    origin_scene_id: Option<String>,
    origin_codex_id: Option<String>,
    preview_text: String,
    preview_meta: Option<String>,
    payload: String,
    char_count: i64,
    is_interesting: bool,
    deleted_at: String,
}

fn trash_bin_create_impl(
    db: &database::Database,
    payload: TrashBinCreatePayload,
) -> anyhow::Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    db.execute(
        "INSERT INTO trash_items
         (id, project_id, kind, sub_kind, origin_scene_id, origin_codex_id,
          preview_text, preview_meta, payload, char_count, is_interesting, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String(id.clone()),
            Value::String(payload.project_id),
            Value::String(payload.kind),
            Value::String(payload.sub_kind),
            payload
                .origin_scene_id
                .map(Value::String)
                .unwrap_or(Value::Null),
            payload
                .origin_codex_id
                .map(Value::String)
                .unwrap_or(Value::Null),
            Value::String(payload.preview_text),
            payload
                .preview_meta
                .map(Value::String)
                .unwrap_or(Value::Null),
            Value::String(payload.payload),
            Value::Number(payload.char_count.into()),
            Value::Bool(payload.is_interesting),
            Value::String(payload.deleted_at),
        ],
        "run",
    )?;
    let rows = db.execute(
        "SELECT * FROM trash_items WHERE id = ?",
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
pub(crate) fn trash_bin_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: TrashBinCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| trash_bin_create_impl(db, payload))
}

#[tauri::command]
pub(crate) fn trash_bin_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    limit: Option<i64>,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        let limit = limit.unwrap_or(50);
        let rows = db.execute(
            "SELECT * FROM trash_items
             WHERE project_id = ?
             ORDER BY deleted_at DESC
             LIMIT ?",
            &[Value::String(project_id), Value::Number(limit.into())],
            "all",
        )?;
        Ok(rows.into_iter().map(Value::Object).collect())
    })
}

#[tauri::command]
pub(crate) fn trash_bin_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM trash_items WHERE id = ?",
            &[Value::String(id)],
            "run",
        )?;
        Ok(())
    })
}

#[tauri::command]
pub(crate) fn trash_bin_clear_all(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| {
        db.execute(
            "DELETE FROM trash_items WHERE project_id = ?",
            &[Value::String(project_id)],
            "run",
        )?;
        Ok(())
    })
}

/// 期日切れ・件数超過のアイテムを刈り取る。
/// Phase 1 では起動時に呼ぶだけ（バックグラウンド実行は Phase 7）。
#[tauri::command]
pub(crate) fn trash_bin_prune(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    retention_days: i64,
    max_count: i64,
) -> Result<i64, AppError> {
    with_db(&ws_state, |db| {
        // 1. 期日切れ削除（deleted_at < now - retention_days）
        let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_days);
        let cutoff_str = cutoff.to_rfc3339();
        db.execute(
            "DELETE FROM trash_items
             WHERE project_id = ? AND deleted_at < ?",
            &[Value::String(project_id.clone()), Value::String(cutoff_str)],
            "run",
        )?;

        // 2. 件数超過削除（古い順に max_count 件まで残す）
        db.execute(
            "DELETE FROM trash_items
             WHERE id IN (
                 SELECT id FROM trash_items
                 WHERE project_id = ?
                 ORDER BY deleted_at DESC
                 LIMIT -1 OFFSET ?
             )",
            &[
                Value::String(project_id.clone()),
                Value::Number(max_count.into()),
            ],
            "run",
        )?;

        // 残件数を返す
        let rows = db.execute(
            "SELECT COUNT(*) AS n FROM trash_items WHERE project_id = ?",
            &[Value::String(project_id)],
            "get",
        )?;
        let count = rows
            .first()
            .and_then(|m| m.get("n"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        Ok(count)
    })
}
