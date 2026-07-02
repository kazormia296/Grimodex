use serde_json::Value;
use tauri::Manager;

use super::{with_db, AppError, WorkspaceState};

#[tauri::command]
pub(crate) async fn fts_optimize(app: tauri::AppHandle) -> Result<(), AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let ws_state = app.state::<WorkspaceState>();
        with_db(&ws_state, |db| db.fts_optimize())
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

#[tauri::command]
pub(crate) async fn fts_rebuild(app: tauri::AppHandle) -> Result<(), AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let ws_state = app.state::<WorkspaceState>();
        with_db(&ws_state, |db| db.fts_rebuild())
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

#[tauri::command]
pub(crate) async fn fts_rebuild_en(app: tauri::AppHandle) -> Result<(), AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let ws_state = app.state::<WorkspaceState>();
        with_db(&ws_state, |db| db.rebuild_en_fts())
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

#[tauri::command(async)]
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

#[tauri::command(async)]
pub(crate) fn integrity_check(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.integrity_check())
}

#[tauri::command]
pub(crate) async fn repair_integrity(
    app: tauri::AppHandle,
) -> Result<serde_json::Map<String, Value>, AppError> {
    let result = tauri::async_runtime::spawn_blocking(
        move || -> Result<serde_json::Map<String, Value>, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            with_db(&ws_state, |db| db.repair_integrity())
        },
    )
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}
