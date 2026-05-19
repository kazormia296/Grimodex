use serde::Serialize;
use std::path::PathBuf;

use crate::database::Database;
use crate::semantic::search::SearchCache;
use crate::workspace::{self, GlobalSettings};

use super::{ActiveWorkspace, AppError, GlobalSettingsPath, WorkspaceState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
}

#[tauri::command]
pub(crate) fn get_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
) -> Result<GlobalSettings, AppError> {
    Ok(workspace::read_global_settings(&gs_path.path))
}

#[tauri::command]
pub(crate) fn save_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    settings: GlobalSettings,
) -> Result<(), AppError> {
    workspace::write_global_settings(&gs_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn validate_workspace_path(path: String) -> bool {
    let p = PathBuf::from(&path);
    p.exists() && p.is_dir() && p.join("grimodex.db").exists()
}

#[tauri::command]
pub(crate) fn open_workspace(
    ws_state: tauri::State<'_, WorkspaceState>,
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    semantic_cache: tauri::State<'_, SearchCache>,
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

    // Semantic search の in-memory cache は前 workspace の scene_id を握っているので
    // 切替時に必ず捨てる (UUID 衝突は起きないが、安全側に倒す)。
    semantic_cache.clear()?;

    // Update global settings
    let mut settings = workspace::read_global_settings(&gs_path.path);
    let now = chrono::Utc::now().to_rfc3339();
    workspace::touch_recent_workspace(&mut settings, &path, &now);
    workspace::write_global_settings(&gs_path.path, &settings)?;

    let name = workspace::workspace_name(&path);
    Ok(OpenWorkspaceResult { name, is_existing })
}
