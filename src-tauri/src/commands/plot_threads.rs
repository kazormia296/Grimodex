//! Plot thread (Plottr 型プロットスレッド) Tauri commands.
//!
//! 実装本体は grimodex-db (`crates/grimodex-db/src/plot_threads.rs`) に移動した
//! (Electron 移行 Phase 3 バッチ1 — napi `Backend` と Tauri コマンドで共用するため。
//! trash_bin と同じ構図)。ここは `with_db` への薄いラッパーのみで、署名・SQL・
//! XPROJ ガード・エラー契約・挙動は移動前と完全に同一。
//!
//! `plot_threads` = タイムライン上の名前付き横レーン、
//! `plot_thread_scene_links` = スレッドが特定シーンで踏む段階マーカー。
//! schema は src-tauri/src/database/migrate.rs と src/db/schema.ts でミラー。

use serde_json::Value;

use crate::database::plot_threads::{
    self, PlotThreadBranchCreatePayload, PlotThreadCreatePayload, PlotThreadDeleteSnapshotPayload,
    PlotThreadLinkCreatePayload, PlotThreadLinkPatch, PlotThreadMoveMarkerBundlePayload,
    PlotThreadPatch, PlotThreadRestoreSnapshotPayload,
};

use super::{with_db, AppError, WorkspaceState};

// ─────────────────────── thread CRUD ───────────────────────

#[tauri::command(async)]
pub(crate) fn plot_thread_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::create(db, payload))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::update(db, id, patch))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| plot_threads::delete(db, id))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_list(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| plot_threads::list(db, project_id))
}

// ─────────────────────── link CRUD ───────────────────────

#[tauri::command(async)]
pub(crate) fn plot_thread_link_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadLinkCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::link_create(db, payload))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_link_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
    patch: PlotThreadLinkPatch,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::link_update(db, id, patch))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_link_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    id: String,
) -> Result<(), AppError> {
    with_db(&ws_state, |db| plot_threads::link_delete(db, id))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_list_links(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| plot_threads::list_links(db, project_id))
}

// ─────────────────────── branch create ───────────────────────

/// Compatibility wrapper for the frozen Tauri shell. Domain logic remains in
/// the shared crate used by Electron/N-API and BrowserMock exposes the same
/// typed command, so every runtime shares one renderer contract.
#[tauri::command(async)]
pub(crate) fn plot_thread_branch_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadBranchCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::branch_create(db, payload))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_move_marker_bundle(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadMoveMarkerBundlePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        plot_threads::move_marker_bundle(db, payload)
    })
}

#[tauri::command(async)]
pub(crate) fn plot_thread_restore_snapshot(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadRestoreSnapshotPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::restore_snapshot(db, payload))
}

#[tauri::command(async)]
pub(crate) fn plot_thread_delete_snapshot(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: PlotThreadDeleteSnapshotPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| plot_threads::delete_snapshot(db, payload))
}
