use tauri::Manager;

use super::{AppError, GlobalSettingsPath};
use grimodex_db::sample_seed::{self, SeedResult};

/// Tauri adapter for the shell-independent sample seeding core.
///
/// Caller must invoke `open_workspace(path)` afterwards to set the active
/// workspace.
#[tauri::command]
pub(crate) async fn seed_sample_workspace(
    app: tauri::AppHandle,
    language: String,
    ai_policy: String,
) -> Result<SeedResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let global_settings = app.state::<GlobalSettingsPath>();
        sample_seed::seed_sample_workspace(&global_settings, &language, &ai_policy)
    })
    .await
    .map_err(|error| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {error}")))?
}
