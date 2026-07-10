//! Trash bin Tauri commands.
//!
//! 実装本体は grimodex-db (`crates/grimodex-db/src/trash_bin.rs`) に移動した
//! (Electron 移行: napi 垂直スライスに trash_bin を追加し Tauri と共用するため
//! — S1 の抽出と同じ構図)。ここは `with_db` への薄いラッパーのみで、
//! 署名・エラー契約・挙動は移動前と完全に同一。
//!
//! Phase 1 では文字屑のみ書き込まれる。`payload` / `preview_meta` は
//! 素の TEXT で JSON 文字列を保持し、フロント側で `JSON.parse` する。

use serde_json::Value;

use crate::database::trash_bin::{self, TrashBinCreatePayload};

use super::{with_db, AppError, WorkspaceState};

#[tauri::command(async)]
pub(crate) fn trash_bin_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: TrashBinCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| trash_bin::create(db, payload))
}

#[tauri::command(async)]
pub(crate) fn trash_bin_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    limit: Option<i64>,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| trash_bin::list(db, project_id, limit))
}

#[tauri::command(async)]
pub(crate) fn trash_bin_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| trash_bin::delete(db, id))
}

#[tauri::command(async)]
pub(crate) fn trash_bin_clear_all(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| trash_bin::clear_all(db, project_id))
}

/// 期日切れ・件数超過のアイテムを刈り取る。
/// Phase 1 では起動時に呼ぶだけ（バックグラウンド実行は Phase 7）。
#[tauri::command(async)]
pub(crate) fn trash_bin_prune(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    retention_days: i64,
    max_count: i64,
) -> Result<i64, AppError> {
    with_db(&ws_state, |db| {
        trash_bin::prune(db, project_id, retention_days, max_count)
    })
}
