use serde_json::Value;

use super::{with_db, AppError, WorkspaceState};

#[tauri::command]
pub(crate) fn fts_optimize(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_optimize())
}

#[tauri::command]
pub(crate) fn fts_rebuild(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_rebuild())
}

#[tauri::command]
pub(crate) fn fts_rebuild_en(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.rebuild_en_fts())
}

#[tauri::command]
pub(crate) fn fts_search(
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

#[tauri::command]
pub(crate) fn integrity_check(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.integrity_check())
}

#[tauri::command]
pub(crate) fn repair_integrity(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.repair_integrity())
}
