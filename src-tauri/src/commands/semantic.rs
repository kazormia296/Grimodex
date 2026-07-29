//! Thin Tauri adapter for the shell-independent semantic runtime.

#![cfg(feature = "semantic-embedding")]

use std::sync::Arc;

use grimodex_db::events::EventSink;
use grimodex_db::state::active_database;
use grimodex_semantic::chat_index::ChatIndexStatus;
use grimodex_semantic::chat_search::ChatSearchHit;
use grimodex_semantic::codex_index::CodexIndexStatus;
use grimodex_semantic::codex_search::CodexSearchHit;
use grimodex_semantic::events_index::EventsIndexStatus;
use grimodex_semantic::events_search::EventSearchHit;
use grimodex_semantic::index::IndexStatusReport;
use grimodex_semantic::preview::PreviewContext;
use grimodex_semantic::runtime::{
    DebugDumpReport, ModelDownloadStart, SemanticRequest, SemanticRuntime,
};
use grimodex_semantic::search::SearchHit;
use tauri::{Emitter, Manager};

use super::{AppError, WorkspaceState};

/// Tauri implementation of the shared best-effort event transport.
pub(crate) struct TauriSemanticEventSink {
    pub(crate) app: tauri::AppHandle,
}

impl EventSink for TauriSemanticEventSink {
    fn emit(&self, channel: &str, payload: serde_json::Value) {
        if let Err(error) = Emitter::emit(&self.app, channel, payload) {
            tracing::warn!(channel, %error, "semantic event emit failed");
        }
    }
}

fn runtime_and_request(
    app: &tauri::AppHandle,
) -> Result<(Arc<SemanticRuntime>, SemanticRequest), AppError> {
    let runtime_state = app.state::<Arc<SemanticRuntime>>();
    let runtime = Arc::clone(runtime_state.inner());
    let workspace = app.state::<WorkspaceState>();
    let request = runtime.pin_request(|| active_database(&workspace))?;
    Ok((runtime, request))
}

async fn run_blocking<T: Send + 'static>(
    operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {error}")))?
        .map_err(AppError::Anyhow)
}

#[tauri::command]
pub(crate) async fn semantic_cancel_background(app: tauri::AppHandle) -> Result<u64, AppError> {
    let runtime_state = app.state::<Arc<SemanticRuntime>>();
    Ok(runtime_state.semantic_cancel_background())
}

#[tauri::command]
pub(crate) async fn semantic_download_model(
    app: tauri::AppHandle,
    language: String,
) -> Result<String, AppError> {
    let runtime_state = app.state::<Arc<SemanticRuntime>>();
    let runtime = Arc::clone(runtime_state.inner());
    let start = runtime.semantic_download_model(&language)?;
    let status = start.status().to_string();
    if let ModelDownloadStart::Start(job) = start {
        tauri::async_runtime::spawn(async move {
            let _ = job.run().await;
        });
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn semantic_index_scene(
    app: tauri::AppHandle,
    scene_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.semantic_index_scene(&request, &scene_id)).await
}

#[tauri::command]
pub(crate) async fn semantic_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
    scene_scope: Option<String>,
    description_mode: Option<bool>,
) -> Result<Vec<SearchHit>, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || {
        runtime.semantic_search(
            &request,
            &project_id,
            &query,
            limit,
            scene_scope.as_deref(),
            description_mode,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn codex_index_entry(
    app: tauri::AppHandle,
    entry_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.codex_index_entry(&request, &entry_id)).await
}

#[tauri::command]
pub(crate) async fn codex_semantic_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<CodexSearchHit>, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.codex_semantic_search(&request, &project_id, &query, limit)).await
}

#[tauri::command]
pub(crate) async fn codex_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<CodexIndexStatus, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.codex_index_status(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn codex_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.codex_reindex_all(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn events_index_entry(
    app: tauri::AppHandle,
    event_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.events_index_entry(&request, &event_id)).await
}

#[tauri::command]
pub(crate) async fn events_semantic_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<EventSearchHit>, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.events_semantic_search(&request, &project_id, &query, limit)).await
}

#[tauri::command]
pub(crate) async fn events_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<EventsIndexStatus, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.events_index_status(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn events_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.events_reindex_all(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn chat_index_message(
    app: tauri::AppHandle,
    message_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.chat_index_message(&request, &message_id)).await
}

#[tauri::command]
pub(crate) async fn chat_message_search(
    app: tauri::AppHandle,
    project_id: String,
    query: String,
    limit: usize,
) -> Result<Vec<ChatSearchHit>, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.chat_message_search(&request, &project_id, &query, limit)).await
}

#[tauri::command]
pub(crate) async fn chat_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<ChatIndexStatus, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.chat_index_status(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn chat_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.chat_reindex_all(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn semantic_index_status(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<IndexStatusReport, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.semantic_index_status(&request, &project_id)).await
}

#[tauri::command]
pub(crate) async fn semantic_reindex_all(
    app: tauri::AppHandle,
    project_id: String,
    run_id: Option<String>,
) -> Result<usize, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || runtime.semantic_reindex_all(&request, &project_id, run_id.as_deref()))
        .await
}

#[tauri::command]
pub(crate) async fn semantic_chunk_context(
    app: tauri::AppHandle,
    scene_id: String,
    char_start: usize,
    char_end: usize,
    padding: usize,
) -> Result<PreviewContext, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || {
        runtime.semantic_chunk_context(&request, &scene_id, char_start, char_end, padding)
    })
    .await
}

#[tauri::command]
pub(crate) async fn semantic_debug_dump(
    app: tauri::AppHandle,
    project_id: String,
    scene_id: Option<String>,
    limit: Option<usize>,
) -> Result<DebugDumpReport, AppError> {
    let (runtime, request) = runtime_and_request(&app)?;
    run_blocking(move || {
        runtime.semantic_debug_dump(&request, &project_id, scene_id.as_deref(), limit)
    })
    .await
}
