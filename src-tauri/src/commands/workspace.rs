use serde::Serialize;
use std::path::PathBuf;
#[cfg(feature = "semantic-embedding")]
use std::sync::Arc;
use tauri::Manager;

use crate::workspace::{self, GlobalSettings};
#[cfg(feature = "semantic-embedding")]
use grimodex_semantic::runtime::SemanticRuntime;

use super::{AppError, GlobalSettingsPath, WorkspaceState};

// open_workspace の本体 (migrate → swap → SwitchingGuard、重い maintenance は
// authority commit 後の worker) と
// reject_unsafe_workspace_path (PIO-1 ガード) は grimodex-db::open へ抽出した
// (Electron 移行 Phase 2 S1)。reject_unsafe_workspace_path は
// external_mount.rs が `crate::commands::workspace::` 経由で再利用するため
// 従来パスで re-export する。
use grimodex_db::backup_restore::list_backups as list_backups_shared;
pub(crate) use grimodex_db::backup_restore::{restore_backup_core, BackupInfo};
pub(crate) use grimodex_db::open::reject_unsafe_workspace_path;
use grimodex_db::open::{open_workspace_sync, OpenDeps, OpenWorkspaceResult};
use grimodex_db::state::active_workspace_path;

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
        #[cfg(feature = "semantic-embedding")]
        let semantic_runtime = app.state::<Arc<SemanticRuntime>>();

        restore_backup_core(&ws_state, &file_name, || {
            #[cfg(feature = "semantic-embedding")]
            semantic_runtime.rotate_workspace_epoch();
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
            #[cfg(feature = "semantic-embedding")]
            let semantic_runtime = app.state::<Arc<SemanticRuntime>>();

            // 本体 (open_lock 直列化 → migrate → swap → SwitchingGuard →
            // authority commit 後の maintenance worker →
            // recent-workspaces 更新) は grimodex_db::open::open_workspace_sync。
            // Tauri 側にしか無い後処理 = semantic cache epoch の rotation を
            // on_swapped フックで注入する (DB swap 直後・switching=true のまま)。
            // 新しい command は fresh cache Arc を取得し、切替前から走っている task
            // が旧 cache へ遅れて put しても新 workspace からは不可視になる。
            let mut on_swapped = || {
                #[cfg(feature = "semantic-embedding")]
                semantic_runtime.rotate_workspace_epoch();
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
    /// Arguments inserted before `--workspace`. The unified Tauri executable
    /// needs its `mcp` subcommand; Electron's standalone sidecar inserts the
    /// trusted main-process `--license-file` path instead.
    args_prefix: Vec<String>,
}

/// Return the data an external MCP client needs to spawn this app as its
/// MCP server: the absolute path to the app binary and the open workspace
/// dir. The frontend assembles the `.mcp.json` snippet from this (using the
/// shell-provided `argsPrefix`, then adding `--project` and `--readonly`).
/// Errors if no workspace is open or a workspace switch is in progress.
#[tauri::command(async)]
pub(crate) fn get_mcp_config(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<McpConfigInfo, AppError> {
    let command = current_mcp_command_path()?;
    let workspace = active_workspace_path(&ws_state)?
        .to_string_lossy()
        .into_owned();
    Ok(McpConfigInfo {
        command,
        workspace,
        args_prefix: vec!["mcp".to_string()],
    })
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
