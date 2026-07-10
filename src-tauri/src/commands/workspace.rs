use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

use crate::database::Database;
use crate::semantic::chat_search::ChatSearchCache;
use crate::semantic::codex_search::CodexSearchCache;
use crate::semantic::events_search::EventsSearchCache;
use crate::semantic::search::SearchCache;
use crate::workspace::{self, GlobalSettings};

use super::{ActiveWorkspace, AppError, GlobalSettingsPath, WorkspaceState};

// open_workspace の本体 (backup → migrate → swap → SwitchingGuard) と
// reject_unsafe_workspace_path (PIO-1 ガード) は grimodex-db::open へ抽出した
// (Electron 移行 Phase 2 S1)。reject_unsafe_workspace_path は
// external_mount.rs が `crate::commands::workspace::` 経由で再利用するため
// 従来パスで re-export する。
pub(crate) use grimodex_db::open::reject_unsafe_workspace_path;
use grimodex_db::open::{open_workspace_sync, OpenDeps, OpenWorkspaceResult, SwitchingGuard};

// ===========================================================================
// アプリ内バックアップ復元 (backup restore Phase 1)
// ===========================================================================

/// バックアップ一覧の 1 エントリ。フロント (設定 > データ) が復元候補として表示する。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupInfo {
    /// `<ws>/backups/` 内のファイル名 (basename)。`restore_backup` にそのまま渡す。
    file_name: String,
    size_bytes: u64,
    /// mtime (epoch ms)。フロントのソート/表示用。
    modified_ms: u64,
    /// "db" (無圧縮) | "db.gz" (Phase 2 で追加)。復元可否の判定に使う。
    format: String,
}

/// アクティブ workspace の `backups/` を列挙し、新しい順で返す。workspace 未オープン
/// ならエラー。ディレクトリが無ければ空 (まだバックアップ無し)。
#[tauri::command]
pub(crate) fn list_backups(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<Vec<BackupInfo>, AppError> {
    let dir = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner
            .as_ref()
            .ok_or(AppError::NoWorkspace)?
            .path
            .join("backups")
    };
    Ok(list_backups_in(&dir))
}

/// `dir` 内の `grimodex-*.db` / `grimodex-*.db.gz` を集約し新しい順にソート。
/// `.tmp` 等は無視する。tauri::State を剥がしテスト可能にした本体。
fn list_backups_in(dir: &Path) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out; // backups ディレクトリ未作成 = バックアップ無し
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("grimodex-") {
            continue;
        }
        let format = if name.ends_with(".db.gz") {
            "db.gz"
        } else if name.ends_with(".db") {
            "db"
        } else {
            continue; // .tmp ステージングやそれ以外は除外
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(BackupInfo {
            file_name: name,
            size_bytes: meta.len(),
            modified_ms,
            format: format.to_string(),
        });
    }
    out.sort_by_key(|b| std::cmp::Reverse(b.modified_ms)); // 新しい順
    out
}

/// 選択したバックアップでアクティブ workspace の `grimodex.db` を置き換える
/// (backup restore Phase 1)。フロントは成功後に `window.location.reload()` する。
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
            // 再オープン直後: 前 DB の scene_id を握る in-memory cache を捨てる
            // (open_workspace と同じ。失敗は stale cache 許容で続行)。
            if let Err(e) = semantic_cache.clear() {
                tracing::warn!("semantic cache clear after restore failed: {e}");
            }
            if let Err(e) = codex_semantic_cache.clear() {
                tracing::warn!("codex semantic cache clear after restore failed: {e}");
            }
            if let Err(e) = events_semantic_cache.clear() {
                tracing::warn!("events semantic cache clear after restore failed: {e}");
            }
            if let Err(e) = chat_semantic_cache.clear() {
                tracing::warn!("chat semantic cache clear after restore failed: {e}");
            }
        })
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?
}

/// `restore_backup` の本体 (tauri::State / caches を剥がしテスト可能に)。
/// `on_reopened` は再オープン成功後・inner セット前に呼ばれ caches クリア等を担う
/// (この時点で switching はまだ true)。
///
/// 手順: (1) 現行 DB を安全退避 → (2) switching で新規 DB アクセスを止め、in-flight を
/// 待って接続をクローズ → (3) 旧 wal/shm 削除 (残すとリプレイ破損) → (4) ファイル置換
/// → (5) 再オープン。候補は破壊前に quick_check し、壊れたバックアップでは何も破壊しない。
pub(crate) fn restore_backup_core(
    ws_state: &WorkspaceState,
    file_name: &str,
    on_reopened: impl FnOnce(),
) -> Result<(), AppError> {
    // open 自体と同じ番兵で直列化 (併走 open / 二重 restore を防ぐ)。
    let _open_guard = ws_state
        .open_lock
        .lock()
        .map_err(|e| anyhow::anyhow!("{e}"))?;

    // 現行 workspace のパス (未オープンなら NoWorkspace)。
    let ws_path = {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner.as_ref().ok_or(AppError::NoWorkspace)?.path.clone()
    };

    // file_name は <ws>/backups 直下の basename のみ許可 (traversal 拒否)。
    let src = resolve_backup_path(&ws_path, file_name)?;

    // 対応形式: 無圧縮 .db / gzip .db.gz (backup restore Phase 2)。
    let name = src.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let is_gz = name.ends_with(".db.gz");
    if !(is_gz || name.ends_with(".db")) {
        return Err(
            anyhow::anyhow!("この形式のバックアップは復元に対応していません: {file_name}").into(),
        );
    }

    let db_path = ws_path.join("grimodex.db");
    let backups_dir = ws_path.join("backups");

    // 候補を平文 .db として materialize (gzip なら解凍) し、quick_check に通す。
    // ここは switching 前 = セッションに触れないので、壊れた/展開失敗のバックアップでも
    // 現行セッションは無傷のまま失敗させられる。以降の置換はこの検証済み平文を rename
    // するだけ (原子)。materialize 先 `grimodex.db.restore-tmp` は is_backup_file に
    // マッチしないので一覧・ローテには出ない。
    let staged_plain = sidecar(&db_path, ".restore-tmp");
    remove_if_exists(&staged_plain);
    let prepared: anyhow::Result<()> = (|| {
        if is_gz {
            crate::database::gunzip_file(&src, &staged_plain)
                .map_err(|e| anyhow::anyhow!("バックアップの解凍に失敗しました: {e}"))?;
        } else {
            std::fs::copy(&src, &staged_plain)
                .map_err(|e| anyhow::anyhow!("復元DBのステージングに失敗しました: {e}"))?;
        }
        Ok(())
    })();
    if let Err(e) = prepared {
        remove_if_exists(&staged_plain);
        return Err(e.into());
    }
    if let Err(e) = verify_sqlite_ok(&staged_plain) {
        remove_if_exists(&staged_plain);
        return Err(e);
    }

    // (1) 新規 DB アクセスを止め、アクティブ workspace を外して in-flight を drain する。
    //     安全退避より先に switching を立てて quiesce することで、退避スナップショット
    //     以降に「保存成功」を返した書き込みが復元で失われる窓を無くす。
    ws_state
        .switching
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let _switching_guard = SwitchingGuard(&ws_state.switching);

    let old = {
        let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        inner.take()
    };
    let old = old.ok_or(AppError::NoWorkspace)?;

    // in-flight with_db がクローンした Arc が全て落ちる (strong_count==1) まで待つ。
    // ここまで grimodex.db は未変更なので、タイムアウト時は old を戻して安全に中止できる。
    if let Err(e) = wait_for_sole_owner(&old.db) {
        let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        *inner = Some(old);
        remove_if_exists(&staged_plain);
        return Err(e);
    }

    // (2) 復元前の安全退避 (best-effort): quiesce 後の現行 DB を通常バックアップとして
    //     書き出し、ユーザーが復元を「元へ戻せる」ようにする。**失敗しても中止しない** —
    //     現行 DB が破損している状況こそ復元が必要な場面であり、そこで VACUUM INTO が
    //     失敗して復元を諦めさせるのは本末転倒 (maybe_auto_backup も quick_check 破損で
    //     「復旧用に」退避する方針)。ENOSPC ならこの後の staging でも失敗するので
    //     grimodex.db は無傷のまま返る。
    if let Err(e) = std::fs::create_dir_all(&backups_dir) {
        tracing::warn!("restore: cannot create backups dir for safety copy: {e}");
    } else {
        // `%3f` = ミリ秒。同一秒に複数バックアップ（連続復元の安全退避や、safety が
        // auto-backup と同秒）を書くと backup_to の rename が既存を上書きして世代を 1 つ失う
        // ため、サブ秒のエントロピを足して衝突を避ける（敵対レビュー minor）。
        let ts = chrono::Utc::now().format("%Y%m%d-%H%M%S%3f");
        // 安全退避も通常バックアップと同じ gzip 形式 (Phase 2)。
        let safety = backups_dir.join(format!("grimodex-{ts}.db.gz"));
        if let Err(e) = old.db.backup_to(&safety) {
            tracing::warn!("restore: pre-restore safety backup failed (continuing): {e}");
        }
    }

    // (3) 最後の Arc を落とす = Database → conn: Mutex<Connection> クローズ = ファイル
    //     ハンドル解放 (特に Windows)。ここから grimodex.db は「開いていない」状態。
    drop(old);

    // (4) WAL/SHM の残骸を削除。残った -wal は復元 DB に stale フレームをリプレイして
    //     破損させる (VACUUM INTO 出力は sidecar を持たない)。接続クローズ時に checkpoint
    //     済みなので主 DB のデータは失われない。
    remove_if_exists(&sidecar(&db_path, "-wal"));
    remove_if_exists(&sidecar(&db_path, "-shm"));

    // (5) 置換は**原子的**: 検証済み平文 staged_plain を rename で grimodex.db に上書き。
    //     rename は両プラットフォームで既存を原子置換するので、失敗しても grimodex.db は
    //     元のまま残る (remove+copy 方式だと copy 途中失敗で消失/切詰め → 次回起動で空 DB
    //     を新規作成し「全損に見える」データ損失になる)。
    if let Err(e) = std::fs::rename(&staged_plain, &db_path)
        .map_err(|e| anyhow::anyhow!("復元DBの適用に失敗しました: {e}"))
    {
        // rename 未達 = grimodex.db は元のまま。staging を片付け、元 DB を開き直して
        // セッションを復帰させてから (workspace-less で固まらせない) エラーを返す。
        remove_if_exists(&staged_plain);
        reactivate_workspace(ws_state, &db_path, &ws_path);
        return Err(e.into());
    }

    // (6) 置換成功。復元済み grimodex.db を開き直す (古いバックアップは migrate で現行
    //     スキーマへ更新)。
    match open_active(&db_path) {
        Ok(database) => {
            // slim バックアップ (Phase 3) は FTS 索引が空。復元 DB の slim マーカーを見て
            // content から rebuild ＋ マーカー消去する (FE reload 後の open_workspace が
            // 二重 rebuild しないように)。埋め込みは reload 後のフロント autoIndex が埋め直す。
            // 失敗しても DB 内容は無事なので warn + 続行 (再オープン失敗経由の reload でも
            // open_workspace の同じ処理が拾う)。
            if let Err(e) = database.rebuild_fts_if_stale() {
                tracing::warn!("restore: fts rebuild after restore failed: {e}");
            }
            on_reopened();
            let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
            *inner = Some(ActiveWorkspace {
                db: std::sync::Arc::new(database),
                path: ws_path,
            });
            Ok(())
        }
        Err(e) => {
            // 復元ファイルは適用済みだが開けない (例: 新しいアプリで作られたバックアップの
            // 前方非互換スキーマ)。grimodex.db 自体は有効なので、フロントは reload →
            // bootstrap open_workspace で開き直す。安定マーカー RESTORE_SESSION_LOST を
            // 含めて FE に reload を促す (src/features/settings/backupApi 側と対)。
            Err(anyhow::anyhow!(
                "RESTORE_SESSION_LOST: 復元DBを開けませんでした（再読み込みします）: {e}"
            )
            .into())
        }
    }
}

/// grimodex.db を Database として開き migrate/optimize する共通処理 (open_workspace と同型)。
fn open_active(db_path: &Path) -> anyhow::Result<Database> {
    let database = Database::new(db_path)?;
    database.migrate()?;
    if let Err(e) = database.optimize() {
        tracing::warn!("PRAGMA optimize after restore failed: {e}");
    }
    Ok(database)
}

/// 置換に失敗した (grimodex.db が元のまま) 際、元 DB を開き直して ActiveWorkspace を
/// 復帰させる (best-effort)。開けなければ inner は None のまま (FE reload に委ねる)。
fn reactivate_workspace(ws_state: &WorkspaceState, db_path: &Path, ws_path: &Path) {
    match open_active(db_path) {
        Ok(database) => {
            if let Ok(mut inner) = ws_state.inner.lock() {
                *inner = Some(ActiveWorkspace {
                    db: std::sync::Arc::new(database),
                    path: ws_path.to_path_buf(),
                });
            }
        }
        Err(e) => {
            tracing::error!("restore: failed to re-open original DB after aborted restore: {e}");
        }
    }
}

/// `<db_path>-wal` / `<db_path>-shm` のような sidecar パスを組む。
fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    let mut os = db_path.as_os_str().to_owned();
    os.push(suffix);
    PathBuf::from(os)
}

/// 存在すれば削除。失敗は warn のみ (復元自体は続行可能)。
fn remove_if_exists(p: &Path) {
    if p.exists() {
        if let Err(e) = std::fs::remove_file(p) {
            tracing::warn!("restore: could not remove {p:?}: {e}");
        }
    }
}

/// `file_name` が `<ws>/backups` 直下の安全な basename であることを検証し絶対パスを返す。
fn resolve_backup_path(ws_path: &Path, file_name: &str) -> Result<PathBuf, AppError> {
    if file_name.is_empty()
        || file_name.contains('/')
        || file_name.contains('\\')
        || file_name.contains("..")
        || !file_name.starts_with("grimodex-")
    {
        return Err(anyhow::anyhow!("不正なバックアップ名です: {file_name}").into());
    }
    let path = ws_path.join("backups").join(file_name);
    if !path.is_file() {
        return Err(anyhow::anyhow!("バックアップが見つかりません: {file_name}").into());
    }
    Ok(path)
}

/// 候補 DB を read-only で開き `quick_check(1)` に通す (壊れたバックアップを弾く)。
fn verify_sqlite_ok(path: &Path) -> Result<(), AppError> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| anyhow::anyhow!("バックアップを開けません: {e}"))?;
    let first: String = conn
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(|e| anyhow::anyhow!("バックアップの整合性チェックに失敗しました: {e}"))?;
    if first != "ok" {
        return Err(anyhow::anyhow!("バックアップが破損しています: {first}").into());
    }
    Ok(())
}

/// switching=true 前提で `db` の Arc が唯一参照になる (in-flight with_db が全て
/// drop する) まで最大 ~10 秒待つ。到達しなければ復元を中止するエラーを返す。
fn wait_for_sole_owner(db: &std::sync::Arc<Database>) -> Result<(), AppError> {
    for _ in 0..1000 {
        if std::sync::Arc::strong_count(db) == 1 {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(anyhow::anyhow!(
        "実行中のDB操作が完了せず復元を中止しました。少し待って再試行してください。"
    )
    .into())
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

#[cfg(test)]
mod tests {
    use super::*;

    // reject_unsafe_workspace_path / is_backup_file のテストは実装ごと
    // grimodex-db (crates/grimodex-db/src/open.rs) へ移動した (Phase 2 S1)。

    #[test]
    fn test_resolve_backup_path_rejects_traversal() {
        // file_name は <ws>/backups 直下の安全な basename のみ。区切り・`..`・
        // 不正 prefix は fs に触れる前に弾く。
        let ws = Path::new("/tmp/ws-does-not-matter");
        for bad in [
            "",
            "../grimodex.db",
            "grimodex-../x.db",
            "sub/grimodex-x.db",
            "grimodex\\x.db",
            "evil.db",
        ] {
            assert!(
                resolve_backup_path(ws, bad).is_err(),
                "should reject unsafe/invalid name {bad:?}"
            );
        }
    }

    #[test]
    fn test_restore_backup_core_reverts_live_changes_and_keeps_safety_copy() {
        // 復元は live の変更 (v2) を捨ててバックアップ時点 (v1) に戻し、置換前に
        // 現行状態を安全退避する。稼働中 DB の接続クローズ→ファイル置換→再オープンの
        // 一連が実際のファイルで通ることを gate する。
        let dir =
            std::env::temp_dir().join(format!("grimodex_restore_core_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let db_path = dir.join("grimodex.db");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("mkdir backups");

        // v1 state。
        let db = Database::new(&db_path).expect("open");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) \
             VALUES ('mark', 'v1', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed v1");

        // v1 を既知の名前でバックアップ。
        let backup_name = "grimodex-20200101-000000.db";
        db.backup_to(&backups.join(backup_name)).expect("backup v1");

        // v2 へ変更 (復元で捨てられるべき)。
        db.execute(
            "UPDATE projects SET title = 'v2' WHERE id = 'mark'",
            &[],
            "run",
        )
        .expect("mutate v2");

        let ws_state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace {
                db: std::sync::Arc::new(db),
                path: dir.clone(),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: std::sync::Mutex::new(()),
        };

        restore_backup_core(&ws_state, backup_name, || {}).expect("restore");

        // アクティブ DB は v1 に戻っている。
        let title = crate::commands::with_db_state(&ws_state, |db| {
            let rows = db.execute("SELECT title FROM projects WHERE id = 'mark'", &[], "get")?;
            Ok(rows[0]["title"].as_str().unwrap_or_default().to_string())
        })
        .expect("query after restore");
        assert_eq!(
            title, "v1",
            "restore は live の v2 変更を破棄して v1 に戻すこと"
        );

        // switching は解除済み。
        assert!(
            !ws_state.switching.load(std::sync::atomic::Ordering::SeqCst),
            "switching は復元後に解除されること"
        );

        // 元バックアップに加え復元前の安全退避が書かれている (計 >=2)。
        assert!(
            list_backups_in(&backups).len() >= 2,
            "復元前の安全バックアップが書かれていること"
        );

        // 原子置換の staging ファイルは残っていない。
        assert!(
            !dir.join("grimodex.db.restore-tmp").exists(),
            "restore-tmp staging ファイルは残らないこと"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_restore_backup_core_rejects_corrupt_backup_without_touching_live_db() {
        // 壊れたバックアップは quick_check で弾かれ、稼働中 DB とセッションは無傷。
        // 「検証してから破壊」= 復元失敗で現行データを壊さない不変条件を gate する。
        let dir =
            std::env::temp_dir().join(format!("grimodex_restore_corrupt_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let db_path = dir.join("grimodex.db");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("mkdir backups");

        let db = Database::new(&db_path).expect("open");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) \
             VALUES ('mark', 'live', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed live");

        // ゴミバイトの「バックアップ」を置く (SQLite として不正)。
        let corrupt = "grimodex-20200101-000000.db";
        std::fs::write(backups.join(corrupt), b"not a sqlite database at all")
            .expect("write corrupt");

        let ws_state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace {
                db: std::sync::Arc::new(db),
                path: dir.clone(),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: std::sync::Mutex::new(()),
        };

        let err = restore_backup_core(&ws_state, corrupt, || {})
            .expect_err("壊れたバックアップは復元不可");
        assert!(
            err.to_string().contains("破損") || err.to_string().contains("整合性"),
            "整合性エラーであること: {err}"
        );

        // 稼働中 DB は無傷で、セッションもそのまま使える。
        let title = crate::commands::with_db_state(&ws_state, |db| {
            let rows = db.execute("SELECT title FROM projects WHERE id = 'mark'", &[], "get")?;
            Ok(rows[0]["title"].as_str().unwrap_or_default().to_string())
        })
        .expect("live db still usable after rejected restore");
        assert_eq!(title, "live", "現行データは失敗した復元で壊れないこと");
        assert!(
            !ws_state.switching.load(std::sync::atomic::Ordering::SeqCst),
            "検証失敗では switching を立てないこと"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_restore_backup_core_from_gzip_backup() {
        // Phase 2: .db.gz バックアップを解凍して復元できること。
        let dir =
            std::env::temp_dir().join(format!("grimodex_restore_gz_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let db_path = dir.join("grimodex.db");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("mkdir backups");

        let db = Database::new(&db_path).expect("open");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) \
             VALUES ('mark', 'v1', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed v1");

        // gzip 形式でバックアップ。
        let backup_name = "grimodex-20200101-000000.db.gz";
        db.backup_to(&backups.join(backup_name))
            .expect("gz backup v1");

        db.execute(
            "UPDATE projects SET title = 'v2' WHERE id = 'mark'",
            &[],
            "run",
        )
        .expect("v2");

        let ws_state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace {
                db: std::sync::Arc::new(db),
                path: dir.clone(),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: std::sync::Mutex::new(()),
        };

        restore_backup_core(&ws_state, backup_name, || {}).expect("restore from gz");

        let title = crate::commands::with_db_state(&ws_state, |db| {
            let rows = db.execute("SELECT title FROM projects WHERE id = 'mark'", &[], "get")?;
            Ok(rows[0]["title"].as_str().unwrap_or_default().to_string())
        })
        .expect("query after restore");
        assert_eq!(title, "v1", ".db.gz 復元も v1 に戻すこと");
        // 解凍 staging は残らない。
        assert!(!dir.join("grimodex.db.restore-tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_restore_rebuilds_fts_from_slim_backup() {
        // Phase 3: slim バックアップは FTS 索引が空。復元後に content から rebuild され
        // 検索が復活することを gate する（external content FTS の無音故障を防ぐ要）。
        let dir =
            std::env::temp_dir().join(format!("grimodex_restore_fts_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        let db_path = dir.join("grimodex.db");
        let backups = dir.join("backups");
        std::fs::create_dir_all(&backups).expect("mkdir backups");

        let db = Database::new(&db_path).expect("open");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) \
             VALUES ('c1','default-project','character','セラフ','古代の守護者スロウン','[]', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed codex");

        // slim gzip バックアップ（FTS 索引は空になる）。
        let backup_name = "grimodex-20200101-000000.db.gz";
        db.backup_to(&backups.join(backup_name))
            .expect("slim backup");

        // content を消してから復元 → 復元で戻る。
        db.execute("DELETE FROM codex_entries WHERE id = 'c1'", &[], "run")
            .expect("del");

        let ws_state = WorkspaceState {
            inner: std::sync::Mutex::new(Some(ActiveWorkspace {
                db: std::sync::Arc::new(db),
                path: dir.clone(),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: std::sync::Mutex::new(()),
        };

        restore_backup_core(&ws_state, backup_name, || {}).expect("restore");

        // 復元後: content が戻り、かつ FTS 検索がヒットする（rebuild 済み）。
        let (codex_n, fts_n) = crate::commands::with_db_state(&ws_state, |db| {
            let c = db.execute(
                "SELECT count(*) AS n FROM codex_entries WHERE id = 'c1'",
                &[],
                "get",
            )?;
            let f = db.execute(
                "SELECT count(*) AS n FROM codex_fts WHERE codex_fts MATCH 'スロウン'",
                &[],
                "get",
            )?;
            Ok((
                c[0]["n"].as_i64().unwrap_or(-1),
                f[0]["n"].as_i64().unwrap_or(-1),
            ))
        })
        .expect("query after restore");
        assert_eq!(codex_n, 1, "restore は content を戻す");
        assert_eq!(fts_n, 1, "restore 後に FTS が rebuild され検索可能");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
