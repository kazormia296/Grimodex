use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;

use crate::database::Database;
use crate::semantic::chat_search::ChatSearchCache;
use crate::semantic::codex_search::CodexSearchCache;
use crate::semantic::events_search::EventsSearchCache;
use crate::semantic::search::SearchCache;
use crate::workspace::{self, GlobalSettings};

use super::{ActiveWorkspace, AppError, GlobalSettingsPath, WorkspaceState};

/// Read a global-scoped setting from the `app_settings` key/value table,
/// falling back to `default` when absent or unreadable.
fn read_app_setting(db: &Database, key: &str, default: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                [key],
                |r| r.get::<_, String>(0),
            )
            .ok())
    })
    .ok()
    .flatten()
    .unwrap_or_else(|| default.to_string())
}

/// Age (seconds) of the most recent `grimodex-*.db` backup in `dir`, if any.
fn newest_backup_age_secs(dir: &Path) -> Option<u64> {
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("grimodex-") && name.ends_with(".db")) {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            newest = Some(newest.map_or(modified, |cur| cur.max(modified)));
        }
    }
    std::time::SystemTime::now()
        .duration_since(newest?)
        .ok()
        .map(|d| d.as_secs())
}

/// Keep the newest `keep` backups (timestamped names sort chronologically),
/// deleting older ones.
fn rotate_backups(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("grimodex-") && n.ends_with(".db"))
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.len() > keep {
        for old in &files[..files.len() - keep] {
            if let Err(e) = std::fs::remove_file(old) {
                tracing::warn!("auto-backup: cannot remove old backup {old:?}: {e}");
            }
        }
    }
}

/// Automatic backup wiring (DB health audit 2026-07): the `data.autoBackup`
/// settings were UI-only, so a corrupt/lost grimodex.db meant total data loss.
/// On workspace open, if enabled and the newest backup is older than the
/// configured interval, write a `VACUUM INTO` snapshot to `<ws>/backups/` and
/// rotate to `maxBackups`. Best-effort: never blocks opening the workspace.
fn maybe_auto_backup(ws_path: &Path, db: &Database) {
    if read_app_setting(db, "data.autoBackup", "true") != "true" {
        return;
    }
    let interval_min: u64 = read_app_setting(db, "data.backupInterval", "60")
        .parse()
        .unwrap_or(60);
    let max_backups: usize = read_app_setting(db, "data.maxBackups", "10")
        .parse()
        .unwrap_or(10)
        .max(1);
    let dir = ws_path.join("backups");

    if let Some(age) = newest_backup_age_secs(&dir) {
        if age < interval_min.saturating_mul(60) {
            return;
        }
    }
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("auto-backup: cannot create backups dir: {e}");
        return;
    }
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let dest = dir.join(format!("grimodex-{ts}.db"));
    match db.quick_check() {
        Ok(Some(report)) => {
            tracing::error!("auto-backup: quick_check reported corruption ({report}); backing up anyway for recovery");
        }
        Err(e) => tracing::warn!("auto-backup: quick_check failed: {e}"),
        Ok(None) => {}
    }
    if let Err(e) = db.backup_to(&dest) {
        tracing::warn!("auto-backup: VACUUM INTO failed: {e}");
        return;
    }
    rotate_backups(&dir, max_backups);
}

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

/// `open_workspace` は renderer 供給のパスにディレクトリ + SQLite DB を作成する。
/// 通常フローでは path はフォルダピッカ / recent / seed 由来の信頼値だが、renderer が
/// 侵害された場合に任意のシステムロケーションへ空ディレクトリ + DB を scaffold される
/// のを防ぐ defense-in-depth (security audit PIO-1)。絶対パスを要求し `..` traversal と
/// システムディレクトリ配下を拒否する。フォルダピッカは外部ドライブ等も返すため
/// home 限定にはしない。
///
/// `external_mount_register` も同じ guard を再利用する (renderer 侵害時に
/// 任意のシステムロケーションを mount root にされ、配下を read される踏み台に
/// なるのを防ぐ。エラー文言は "workspace path" 固定だが security 挙動は同一)。
pub(crate) fn reject_unsafe_workspace_path(ws_path: &Path) -> Result<(), AppError> {
    if !ws_path.is_absolute() {
        return Err(
            anyhow::anyhow!("workspace path must be absolute: {}", ws_path.display()).into(),
        );
    }
    if ws_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(anyhow::anyhow!(
            "workspace path must not contain '..': {}",
            ws_path.display()
        )
        .into());
    }
    // workspace ディレクトリ自体はまだ存在しないことがあるため、既存の最近接祖先を
    // canonicalize してシステムディレクトリ配下かどうかを判定する。
    let mut probe: &Path = ws_path;
    let canonical = loop {
        if let Ok(c) = probe.canonicalize() {
            break Some(c);
        }
        match probe.parent() {
            Some(parent) => probe = parent,
            None => break None,
        }
    };
    if let Some(canonical) = canonical {
        if is_system_directory(&canonical) {
            return Err(anyhow::anyhow!(
                "refusing to create a workspace under a system directory: {}",
                canonical.display()
            )
            .into());
        }
    }
    Ok(())
}

#[cfg(unix)]
fn is_system_directory(path: &Path) -> bool {
    if path == Path::new("/") {
        return true;
    }
    // ユーザデータが置かれない明白なシステムルートのみ。`/tmp` `/var/folders` 等の
    // 一時領域は除外 (誤検知でテスト/正規利用を壊さないため)。
    const DENY: &[&str] = &[
        "/bin",
        "/sbin",
        "/boot",
        "/dev",
        "/etc",
        "/lib",
        "/lib64",
        "/proc",
        "/sys",
        "/usr",
        "/System",
        "/private/etc",
    ];
    DENY.iter().any(|d| path.starts_with(d))
}

#[cfg(not(unix))]
fn is_system_directory(path: &Path) -> bool {
    // Windows: %SystemRoot% / Program Files 配下を拒否 (drive letter 非依存に env から解決)。
    const DENY_ENV: &[&str] = &["SystemRoot", "ProgramFiles", "ProgramFiles(x86)"];
    DENY_ENV.iter().any(|var| {
        std::env::var_os(var)
            .map(PathBuf::from)
            .and_then(|p| p.canonicalize().ok())
            .map(|p| path.starts_with(&p))
            .unwrap_or(false)
    })
}

/// RAII: `WorkspaceState::switching` を全 exit (正常・エラー・panic 巻き戻し)
/// で確実に false へ戻す。open_workspace が途中で `?` で抜けてもフラグが
/// 立ちっぱなしにならない (立ちっぱなし = 全 DB コマンドが恒久拒否 = 文鎮化)。
struct SwitchingGuard<'a>(&'a std::sync::atomic::AtomicBool);

impl Drop for SwitchingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
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

            // open 自体を直列化 (併走 migrate の check-then-act / 二重
            // VACUUM INTO 防止)。ロック順序は open_lock → inner → write_lock
            // の一方向のみ (with_db は inner のみ取るので循環しない)。
            let _open_guard = ws_state
                .open_lock
                .lock()
                .map_err(|e| anyhow::anyhow!("{e}"))?;

            let ws_path = PathBuf::from(&path);
            reject_unsafe_workspace_path(&ws_path)?;
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
            // Refresh planner stats on open (cheap: analysis_limit is set). Non-fatal —
            // a stats refresh failure must not block opening the workspace.
            if let Err(e) = database.optimize() {
                tracing::warn!("PRAGMA optimize on workspace open failed: {e}");
            }
            // Automatic backup (best-effort, throttled by data.backupInterval).
            maybe_auto_backup(&ws_path, &database);
            // Age out unbounded append-only logs (90-day retention; change_events is
            // excluded — hash chain). Non-fatal.
            if let Err(e) = database.prune_old_logs(90) {
                tracing::warn!("prune_old_logs on workspace open failed: {e}");
            }

            // swap 直前で switching を立てる (Fix I3)。ここまでの migrate /
            // VACUUM / prune の数秒間は旧 DB への正当な読み書き (切替中も
            // 生きている旧 UI の検索・チャット・保存) を通したままにし、
            // swap 区間だけ with_db を明示エラーで拒否する。swap 前に
            // 走り出した with_db は inner ロックで直列化されるので安全性は
            // 同等。ガードの Drop 復帰 (正常・エラー・panic) は維持。
            // _open_guard より後に宣言 = 先に drop されるので、open_lock
            // 解放時には必ずフラグは戻っている。
            ws_state
                .switching
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let _switching_guard = SwitchingGuard(&ws_state.switching);

            // Set as active workspace
            let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
            *inner = Some(ActiveWorkspace {
                db: database,
                path: ws_path,
            });

            // =================================================================
            // 不変条件: swap (上の *inner = Some(...)) 以降は絶対に Err を
            // 返さないこと (infallible)。フロント (workspace/store.ts) の
            // endWorkspaceSwitch({restoreBinding}) 判定は「invoke エラー ⟹
            // swap 未実行」に依存しており、swap 後に Err を返すと旧束縛が
            // 復元され、旧束縛のまま新 DB へ timelapse が記録される (C1 の
            // 最悪形)。以降の失敗は tracing::warn で握って続行する
            // (workspace 自体は開けているので open 全体を失敗させない方が
            // 正しい)。残余: spawn_blocking の JoinError (swap 後の panic)
            // だけはこの契約の外だが、unwrap() 禁止のコードベースで panic は
            // 既に異常系。
            // =================================================================

            // Semantic search の in-memory cache は前 workspace の scene_id を握っているので
            // 切替時に必ず捨てる (UUID 衝突は起きないが、安全側に倒す)。
            // 失敗 (poisoned mutex) は stale cache を許容して続行 — 検索結果が
            // 一時的に古くなるだけで、次の clear / 再 index で回復する。
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

            // Update global settings (write_lock で read-modify-write を
            // 原子化。save_global_settings / seed_sample_workspace と並行
            // しても lost update しない)。失敗 (ENOSPC / EACCES / AV による
            // rename ロック / 毒化) は recent-workspaces が更新されないだけ
            // なので warn で続行 (上の不変条件)。
            match gs_path.write_lock.lock() {
                Ok(_gs_guard) => {
                    let mut settings = workspace::read_global_settings(&gs_path.path);
                    let now = chrono::Utc::now().to_rfc3339();
                    workspace::touch_recent_workspace(&mut settings, &path, &now);
                    if let Err(e) = workspace::write_global_settings(&gs_path.path, &settings) {
                        tracing::warn!("global settings update on workspace open failed: {e}");
                    }
                }
                Err(e) => {
                    tracing::warn!("global settings lock on workspace open failed: {e}");
                }
            }

            let name = workspace::workspace_name(&path);
            Ok(OpenWorkspaceResult { name, is_existing })
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
        .ok_or_else(|| anyhow::anyhow!("No workspace is open"))?
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_workspace_path() {
        let err = reject_unsafe_workspace_path(Path::new("relative/dir")).unwrap_err();
        assert!(err.to_string().contains("absolute"));
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        #[cfg(unix)]
        let p = Path::new("/home/user/../../etc/evil");
        #[cfg(not(unix))]
        let p = Path::new("C:/Users/user/../../Windows/evil");
        let err = reject_unsafe_workspace_path(p).unwrap_err();
        assert!(err.to_string().contains(".."));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_system_directory() {
        // /etc は存在するシステムディレクトリ。配下への workspace 作成を拒否する。
        let err = reject_unsafe_workspace_path(Path::new("/etc/grimodex-evil")).unwrap_err();
        assert!(err.to_string().contains("system directory"));
    }

    #[cfg(unix)]
    #[test]
    fn allows_path_under_temp() {
        // 一時領域 (テスト/正規利用) は誤検知で弾かない。存在しない leaf でも祖先で判定。
        let base = std::env::temp_dir().join(format!("grimodex-ws-{}", uuid::Uuid::new_v4()));
        assert!(reject_unsafe_workspace_path(&base).is_ok());
    }
}
