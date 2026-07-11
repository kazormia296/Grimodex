//! `open_workspace` の共通本体 (旧 `src-tauri/src/commands/workspace.rs` から
//! Electron 移行 Phase 2 S1 で抽出)。backup → migrate → swap → RAII
//! SwitchingGuard の一連を Tauri コマンド層と napi 層の両方から呼べるようにする。
//! semantic キャッシュのクリア等シェル側にしか無い swap 直後の後処理は
//! `OpenDeps::on_swapped` フックで注入する (napi 側は no-op)。

use serde::Serialize;
use std::path::{Component, Path, PathBuf};

use crate::state::{ActiveWorkspace, GlobalSettingsPath, WorkspaceState};
use crate::workspace;
use crate::{AppError, Database};

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

/// `<ws>/backups/` のバックアップファイル名か（無圧縮 `.db` と gzip `.db.gz` の両方）。
/// `.tmp` ステージングや無関係ファイルは除外。`newest_backup_age_secs` と
/// `rotate_backups` が**同じ判定**を使うことで新旧形式が 1 つの世代集合として扱われる
/// （片方が新形式を漏らすと間引き判定が壊れ毎回バックアップし、旧形式がローテ対象外で
/// 永遠に残る。backup restore Phase 2）。ファイル名の時刻プレフィクスは固定幅なので
/// 拡張子が混在しても名前ソート＝時系列は維持される。
fn is_backup_file(name: &str) -> bool {
    name.starts_with("grimodex-") && (name.ends_with(".db") || name.ends_with(".db.gz"))
}

/// Age (seconds) of the most recent backup in `dir`, if any.
fn newest_backup_age_secs(dir: &Path) -> Option<u64> {
    let mut newest: Option<std::time::SystemTime> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !is_backup_file(&name) {
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
                .map(is_backup_file)
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
    // `%3f` = ミリ秒。同一秒に複数バックアップ（連続復元の安全退避や、safety が
    // auto-backup と同秒）を書くと backup_to の rename が既存を上書きして世代を 1 つ失う
    // ため、サブ秒のエントロピを足して衝突を避ける（敵対レビュー minor）。
    let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
    // gzip 圧縮バックアップ（Phase 2）。
    let dest = dir.join(format!("grimodex-{ts}.db.gz"));
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
pub struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
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
pub fn reject_unsafe_workspace_path(ws_path: &Path) -> Result<(), AppError> {
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
/// `backup_restore::restore_backup_core` も同じガードを使う。
pub struct SwitchingGuard<'a>(pub &'a std::sync::atomic::AtomicBool);

impl Drop for SwitchingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// `open_workspace_sync` へ注入するシェル側依存。
pub struct OpenDeps<'a> {
    /// recent-workspaces 更新先の global-settings.json (write_lock 込み)。
    pub gs_path: &'a GlobalSettingsPath,
    /// swap 直後 (switching=true のまま) に 1 回呼ばれる後処理フック。
    /// Tauri 側は semantic 系 in-memory cache のクリアを注入し、napi 側は
    /// no-op を渡す。ここでの失敗はフック実装側で握ること (open 全体を
    /// 失敗させない — 下記 swap 後 infallible 不変条件)。
    pub on_swapped: &'a mut dyn FnMut(),
}

/// `open_workspace` コマンドの同期本体 (blocking 前提 — 呼び出し側が
/// spawn_blocking 等で退避する)。backup → migrate → swap → RAII
/// SwitchingGuard → recent-workspaces 更新までを行う。
pub fn open_workspace_sync(
    ws_state: &WorkspaceState,
    deps: &mut OpenDeps<'_>,
    path: &str,
) -> Result<OpenWorkspaceResult, AppError> {
    // open 自体を直列化 (併走 migrate の check-then-act / 二重
    // VACUUM INTO 防止)。ロック順序は open_lock → inner → write_lock
    // の一方向のみ (with_db は inner のみ取るので循環しない)。
    let _open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    let ws_path = PathBuf::from(path);
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
    // slim バックアップ復元後などで FTS 索引が空なら content から再構築（自己修復。
    // restore の happy path 以外＝再オープン失敗経由の reload や手動昇格でも検索が
    // 無音故障しないようにする。通常 DB では count だけで no-op）。maybe_auto_backup
    // より前に置き、live の FTS を埋めてからバックアップコピーを slim する。
    if let Err(e) = database.rebuild_fts_if_stale() {
        tracing::warn!("rebuild_fts_if_stale on workspace open failed: {e}");
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
        db: std::sync::Arc::new(database),
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

    // swap 直後のシェル固有後処理 (Tauri: semantic 系 in-memory cache の
    // クリア。前 workspace の scene_id を握っているので切替時に必ず捨てる)。
    // フック内の失敗はフック側で握る契約 (上の不変条件)。
    (deps.on_swapped)();

    // Update global settings (write_lock で read-modify-write を
    // 原子化。save_global_settings / seed_sample_workspace と並行
    // しても lost update しない)。失敗 (ENOSPC / EACCES / AV による
    // rename ロック / 毒化) は recent-workspaces が更新されないだけ
    // なので warn で続行 (上の不変条件)。
    match deps.gs_path.write_lock.lock() {
        Ok(_gs_guard) => {
            let mut settings = workspace::read_global_settings(&deps.gs_path.path);
            let now = chrono::Utc::now().to_rfc3339();
            workspace::touch_recent_workspace(&mut settings, path, &now);
            if let Err(e) = workspace::write_global_settings(&deps.gs_path.path, &settings) {
                tracing::warn!("global settings update on workspace open failed: {e}");
            }
        }
        Err(e) => {
            tracing::warn!("global settings lock on workspace open failed: {e}");
        }
    }

    let name = workspace::workspace_name(path);
    Ok(OpenWorkspaceResult { name, is_existing })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::with_db_state;
    use std::sync::Mutex;

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

    #[test]
    fn test_is_backup_file_accepts_db_and_gz_only() {
        assert!(is_backup_file("grimodex-20260101-000000.db"));
        assert!(is_backup_file("grimodex-20260101-000000.db.gz"));
        assert!(!is_backup_file("grimodex-20260101-000000.db.tmp"));
        assert!(!is_backup_file("grimodex-20260101-000000.db.gz.tmp"));
        // materialize 用 restore-tmp は "grimodex." 始まり (ハイフン無し) で除外。
        assert!(!is_backup_file("grimodex.db.restore-tmp"));
        assert!(!is_backup_file("other.db"));
    }

    #[test]
    fn test_open_workspace_sync_creates_and_reopens_workspace() {
        // S1 抽出の gate: 抽出後の open_workspace_sync が (1) 新規 workspace を
        // scaffold + migrate して active にし、(2) on_swapped フックを swap 後に
        // ちょうど 1 回呼び、(3) recent-workspaces を更新し、(4) 再オープンで
        // is_existing=true を返し、(5) SwitchingGuard が switching を戻すこと。
        let dir = std::env::temp_dir().join(format!("grimodex_open_sync_{}", uuid::Uuid::new_v4()));
        let ws_dir = dir.join("ws");
        let gs_file = dir.join("global-settings.json");
        std::fs::create_dir_all(&dir).expect("mkdir");

        let ws_state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let gs_path = GlobalSettingsPath {
            path: gs_file.clone(),
            write_lock: Mutex::new(()),
        };

        let mut swapped = 0u32;
        let mut on_swapped = || swapped += 1;
        let mut deps = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut on_swapped,
        };
        let ws_dir_str = ws_dir.to_string_lossy().into_owned();
        let first = open_workspace_sync(&ws_state, &mut deps, &ws_dir_str).expect("first open");
        assert_eq!(
            serde_json::to_value(&first).expect("json")["isExisting"],
            false
        );
        assert_eq!(swapped, 1, "on_swapped は swap 後にちょうど 1 回呼ばれる");
        assert!(
            !ws_state.switching.load(std::sync::atomic::Ordering::SeqCst),
            "SwitchingGuard が switching を false に戻すこと"
        );

        // migrate 済みの active DB に対して with_db_state で読み書きできる。
        with_db_state(&ws_state, |db| {
            let rows = db.execute("SELECT count(*) AS n FROM projects", &[], "get")?;
            assert!(rows[0]["n"].as_i64().is_some());
            Ok(())
        })
        .expect("query after open");

        // recent-workspaces が更新されている。
        let settings = workspace::read_global_settings(&gs_file);
        assert_eq!(settings.recent_workspaces.len(), 1);
        assert_eq!(settings.last_active_workspace, Some(ws_dir_str.clone()));

        // 再オープンは is_existing=true (grimodex.db が既に存在する)。
        let mut on_swapped2 = || {};
        let mut deps2 = OpenDeps {
            gs_path: &gs_path,
            on_swapped: &mut on_swapped2,
        };
        let second = open_workspace_sync(&ws_state, &mut deps2, &ws_dir_str).expect("reopen");
        assert_eq!(
            serde_json::to_value(&second).expect("json")["isExisting"],
            true
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
