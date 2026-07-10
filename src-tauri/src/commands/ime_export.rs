//! Tauri IPC adapter for the shared IME snapshot exporter.
//!
//! JSON generation and filesystem behavior stay in `grimodex-db::ime_export`
//! so the Tauri and Electron shells expose the same protocol. All operations
//! run on the blocking pool and share one process-local write mutex.

use std::path::PathBuf;
use std::sync::Mutex;

use grimodex_db::ime_export::{
    clear_all_exports, get_status, refresh_project_export, remove_project_export,
    resolve_mode_from_preferences, resolve_options_from_preferences, set_active_project,
    ImeExportOptions, ImeExportRequestGate, ImeExportStatus, ImeIntegrationMode,
};
use grimodex_db::workspace::read_global_settings;
use tauri::Manager;

use super::{with_db, AppError, GlobalSettingsPath, WorkspaceState};

/// App-data IME root and the single-writer guard shared by all IPC commands.
pub(crate) struct ImeExportState {
    pub(crate) root: PathBuf,
    pub(crate) write_lock: Mutex<()>,
    pub(crate) request_gate: ImeExportRequestGate,
}

fn join_error(error: impl std::fmt::Display) -> AppError {
    AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {error}"))
}

fn authoritative_options(
    app: &tauri::AppHandle,
    fallback: &ImeExportOptions,
) -> Result<ImeExportOptions, AppError> {
    let settings_path = app.state::<GlobalSettingsPath>();
    let _guard = settings_path
        .write_lock
        .lock()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
    let settings = read_global_settings(&settings_path.path);
    Ok(resolve_options_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

fn authoritative_mode(
    app: &tauri::AppHandle,
    fallback: ImeIntegrationMode,
) -> Result<ImeIntegrationMode, AppError> {
    let settings_path = app.state::<GlobalSettingsPath>();
    let _guard = settings_path
        .write_lock
        .lock()
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
    let settings = read_global_settings(&settings_path.path);
    Ok(resolve_mode_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

#[tauri::command]
pub(crate) async fn ime_export_refresh(
    app: tauri::AppHandle,
    project_id: String,
    options: ImeExportOptions,
) -> Result<ImeExportStatus, AppError> {
    let options = authoritative_options(&app, &options)?;
    let request = app
        .state::<ImeExportState>()
        .request_gate
        .register_refresh(&project_id, &options);
    tauri::async_runtime::spawn_blocking(move || -> Result<ImeExportStatus, AppError> {
        let state = app.state::<ImeExportState>();
        let _guard = state
            .write_lock
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
        if !state.request_gate.is_current(&request) {
            return get_status(&state.root, options.mode).map_err(AppError::from);
        }
        let workspace = app.state::<WorkspaceState>();
        with_db(&workspace, |db| {
            refresh_project_export(db, &state.root, &project_id, &options)
        })
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn ime_export_set_active_project(
    app: tauri::AppHandle,
    project_id: Option<String>,
    mode: ImeIntegrationMode,
) -> Result<ImeExportStatus, AppError> {
    let mode = authoritative_mode(&app, mode)?;
    let request = app.state::<ImeExportState>().request_gate.register_active();
    tauri::async_runtime::spawn_blocking(move || -> Result<ImeExportStatus, AppError> {
        let state = app.state::<ImeExportState>();
        let _guard = state
            .write_lock
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
        if !state.request_gate.is_current(&request) {
            return get_status(&state.root, mode).map_err(AppError::from);
        }
        set_active_project(&state.root, project_id.as_deref(), mode).map_err(AppError::from)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn ime_export_get_status(
    app: tauri::AppHandle,
    mode: ImeIntegrationMode,
) -> Result<ImeExportStatus, AppError> {
    let mode = authoritative_mode(&app, mode)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<ImeExportStatus, AppError> {
        let state = app.state::<ImeExportState>();
        let _guard = state
            .write_lock
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
        get_status(&state.root, mode).map_err(AppError::from)
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn ime_export_clear_all(app: tauri::AppHandle) -> Result<(), AppError> {
    let request = app.state::<ImeExportState>().request_gate.register_clear();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let state = app.state::<ImeExportState>();
        let _guard = state
            .write_lock
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
        if !state.request_gate.is_current(&request) {
            return Ok(());
        }
        let result = clear_all_exports(&state.root).map_err(AppError::from);
        state.request_gate.finish_clear(&request);
        result
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
pub(crate) async fn ime_export_remove_project(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<(), AppError> {
    let request = app
        .state::<ImeExportState>()
        .request_gate
        .register_remove(&project_id);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let state = app.state::<ImeExportState>();
        let _guard = state
            .write_lock
            .lock()
            .map_err(|error| AppError::Anyhow(anyhow::anyhow!("{error}")))?;
        if !state.request_gate.is_current(&request) {
            return Ok(());
        }
        remove_project_export(&state.root, &project_id).map_err(AppError::from)
    })
    .await
    .map_err(join_error)?
}
