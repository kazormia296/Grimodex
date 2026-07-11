use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

use crate::semantic::chat_search::ChatSearchCache;
use crate::semantic::codex_search::CodexSearchCache;
use crate::semantic::events_search::EventsSearchCache;
use crate::semantic::search::SearchCache;
use crate::workspace::{self, GlobalSettings};

use super::{AppError, GlobalSettingsPath, WorkspaceState};

// open_workspace の本体 (backup → migrate → swap → SwitchingGuard) と
// reject_unsafe_workspace_path (PIO-1 ガード) は grimodex-db::open へ抽出した
// (Electron 移行 Phase 2 S1)。reject_unsafe_workspace_path は
// external_mount.rs が `crate::commands::workspace::` 経由で再利用するため
// 従来パスで re-export する。
use grimodex_db::backup_restore::list_backups as list_backups_shared;
pub(crate) use grimodex_db::backup_restore::{restore_backup_core, BackupInfo};
pub(crate) use grimodex_db::open::reject_unsafe_workspace_path;
use grimodex_db::open::{open_workspace_sync, OpenDeps, OpenWorkspaceResult};

/// アクティブ workspace のバックアップ一覧。列挙・filter・sort の実体は
/// tauri非依存の `grimodex_db::backup_restore` に置く。
#[tauri::command]
pub(crate) fn list_backups(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<BackupInfo>, AppError> {
    list_backups_shared(&ws_state)
}

/// 選択したバックアップを復元するTauri薄層。共有本体の再openフックへ
/// Tauri固有のsemantic系in-memory cache破棄だけを注入する。
#[tauri::command]
pub(crate) async fn restore_backup(
    app: tauri::AppHandle,
    file_name: String,
) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<(), AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let semantic_cache = app.state::<SearchCache>();
        let codex_semantic_cache = app.state::<CodexSearchCache>();
        let events_semantic_cache = app.state::<EventsSearchCache>();
        let chat_semantic_cache = app.state::<ChatSearchCache>();

        restore_backup_core(&ws_state, &file_name, || {
            if let Err(error) = semantic_cache.clear() {
                tracing::warn!("semantic cache clear after restore failed: {error}");
            }
            if let Err(error) = codex_semantic_cache.clear() {
                tracing::warn!("codex semantic cache clear after restore failed: {error}");
            }
            if let Err(error) = events_semantic_cache.clear() {
                tracing::warn!("events semantic cache clear after restore failed: {error}");
            }
            if let Err(error) = chat_semantic_cache.clear() {
                tracing::warn!("chat semantic cache clear after restore failed: {error}");
            }
        })
    })
    .await
    .map_err(|error| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {error}")))?
}

#[tauri::command]
pub(crate) fn get_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
) -> Result<GlobalSettings, AppError> {
    let _guard = gs_path
        .write_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(workspace::read_global_settings(&gs_path.path))
}

#[tauri::command]
pub(crate) fn save_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    settings: GlobalSettings,
) -> Result<(), AppError> {
    let _guard = gs_path
        .write_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    workspace::write_global_settings(&gs_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn validate_workspace_path(path: String) -> bool {
    let p = PathBuf::from(&path);
    p.exists() && p.is_dir() && p.join("grimodex.db").exists()
}

#[tauri::command]
pub(crate) async fn open_workspace(
    app: tauri::AppHandle,
    path: String,
) -> Result<OpenWorkspaceResult, AppError> {
    let result =
        tauri::async_runtime::spawn_blocking(move || -> Result<OpenWorkspaceResult, AppError> {
            let ws_state = app.state::<WorkspaceState>();
            let gs_path = app.state::<GlobalSettingsPath>();
            let semantic_cache = app.state::<SearchCache>();
            let codex_semantic_cache = app.state::<CodexSearchCache>();
            let events_semantic_cache = app.state::<EventsSearchCache>();
            let chat_semantic_cache = app.state::<ChatSearchCache>();

            // 本体 (open_lock 直列化 → backup → migrate → swap → SwitchingGuard →
            // recent-workspaces 更新) は grimodex_db::open::open_workspace_sync。
            // Tauri 側にしか無い後処理 = semantic 系 in-memory cache のクリアを
            // on_swapped フックで注入する (swap 直後・switching=true のまま呼ばれる)。
            // 前 workspace の scene_id を握っているので切替時に必ず捨てる (UUID
            // 衝突は起きないが、安全側に倒す)。失敗 (poisoned mutex) は stale
            // cache を許容して続行 — 検索結果が一時的に古くなるだけで、次の
            // clear / 再 index で回復する (swap 後 infallible 不変条件は
            // open_workspace_sync 側コメント参照)。
            let mut on_swapped = || {
                if let Err(e) = semantic_cache.clear() {
                    tracing::warn!("semantic cache clear on workspace open failed: {e}");
                }
                if let Err(e) = codex_semantic_cache.clear() {
                    tracing::warn!("codex semantic cache clear on workspace open failed: {e}");
                }
                if let Err(e) = events_semantic_cache.clear() {
                    tracing::warn!("events semantic cache clear on workspace open failed: {e}");
                }
                if let Err(e) = chat_semantic_cache.clear() {
                    tracing::warn!("chat semantic cache clear on workspace open failed: {e}");
                }
            };
            let mut deps = OpenDeps {
                gs_path: &gs_path,
                on_swapped: &mut on_swapped,
            };
            open_workspace_sync(&ws_state, &mut deps, &path)
        })
        .await
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfigInfo {
    /// Absolute path to spawn for the MCP server. Since the MCP server is now
    /// unified into the app binary (`Grimodex mcp …` subcommand), this is the
    /// installed app executable itself.
    command: String,
    /// The currently-open workspace directory (`--workspace` argument).
    workspace: String,
}

/// Return the data an external MCP client needs to spawn this app as its
/// MCP server: the absolute path to the app binary and the open workspace
/// dir. The frontend assembles the `.mcp.json` snippet from this (adding the
/// `mcp` subcommand, `--project`, and `--readonly`). Errors if no workspace
/// is open.
#[tauri::command(async)]
pub(crate) fn get_mcp_config(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<McpConfigInfo, AppError> {
    let command = current_mcp_command_path()?;
    let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let workspace = inner
        .as_ref()
        .ok_or(AppError::NoWorkspace)?
        .path
        .to_string_lossy()
        .into_owned();
    Ok(McpConfigInfo { command, workspace })
}

/// Resolve the absolute path an MCP client should spawn.
///
/// On Linux AppImage, `current_exe()` points inside the ephemeral mount
/// (`/tmp/.mount_*/…`) which a client cannot re-spawn later, so prefer the
/// `APPIMAGE` env var (the original AppImage file path) the runtime injects.
/// Otherwise `current_exe()` is correct: macOS `…/Contents/MacOS/Grimodex`,
/// deb/rpm `/usr/bin/grimodex`, Windows `…\Grimodex.exe`.
fn current_mcp_command_path() -> Result<String, AppError> {
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(appimage).to_string_lossy().into_owned());
    }

    Ok(std::env::current_exe()
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .to_string_lossy()
        .into_owned())
}
