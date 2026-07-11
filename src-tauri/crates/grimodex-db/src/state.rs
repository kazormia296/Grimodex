//! workspace 状態 (旧 `src-tauri/src/commands/mod.rs` から Electron 移行
//! Phase 2 S1 で移動)。tauri:: 非依存 — Tauri 側は `app.manage(...)` で、
//! napi 側は `Backend` の `AppState` でこの型をそのまま保持する。

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};
use crate::Database;

/// Holds the currently-open workspace's DB.
/// Wrapped in Option so it can be None before a workspace is opened.
///
/// `db` は `Arc<Database>` にして `with_db_state` が clone-then-drop できる
/// ようにしている: ws_state.inner ロックを SQL 実行の前に解放し、遅いライタ
/// の背後で全リーダ/ライタが直列化されるのを防ぐ (アーキ監査 2026-07 の見出し
/// 「ws_state Mutex を DB コール全体で保持」の解消)。swap 中に発行済みの
/// コマンドは pre-swap で clone した Arc (旧 DB) に着弾するので、新 DB への
/// 混入は起きない (open_workspace の swap 不変条件と両立)。実際の DB 直列化は
/// Database 内部の conn: Mutex<Connection> が引き続き担う。
pub struct ActiveWorkspace {
    pub db: Arc<Database>,
    pub path: PathBuf,
}

pub struct WorkspaceState {
    pub inner: Mutex<Option<ActiveWorkspace>>,
    /// `open_workspace` 実行中フラグ。DB コマンドの async 化 (M3) で
    /// open_workspace と他コマンドが真に並行するようになったため、切替中の
    /// DB アクセスを `with_db` で明示エラーにする (swap を跨いだ write が
    /// 切替後の別 workspace の DB へ黙って落ちるより遥かに良い失敗モード)。
    /// set/reset は open_workspace 内の RAII ガードが行う。
    pub switching: std::sync::atomic::AtomicBool,
    /// `open_workspace` 自体を直列化する番兵。並行 open による同一 DB への
    /// 併走 migrate (add_column_if_missing の check-then-act) と二重
    /// VACUUM INTO を防ぐ。ガードは絶対に await を跨がないこと
    /// (std::sync::MutexGuard は !Send)。
    pub open_lock: Mutex<()>,
}

/// Database and path captured under one `WorkspaceState::inner` lock.
/// Long-running shell adapters keep this value instead of resolving the
/// active workspace again after entering a blocking queue.
#[derive(Clone)]
pub struct ActiveWorkspaceSnapshot {
    pub db: Arc<Database>,
    pub path: PathBuf,
}

/// Path to the global settings file in AppData.
pub struct GlobalSettingsPath {
    pub path: PathBuf,
    /// global-settings.json の read-modify-write を直列化する番兵
    /// (license.rs の `write_lock` と同型)。M3 async 化で blocking pool 上の
    /// open_workspace / seed_sample_workspace と main thread の
    /// save_global_settings が並行しうるため、これが無いと lost update が
    /// 起きる。ガードは絶対に await を跨がないこと
    /// (std::sync::MutexGuard は !Send)。
    pub write_lock: Mutex<()>,
}

/// 現在 workspace の DB を1回だけ解決する。
///
/// 長寿命の background task は開始時にこの `Arc` を保持し、workspace switch 後も
/// 同じ DB へ完了/失敗を保存する。通常の短命 command は `with_db_state` 経由で毎回
/// 解決する。どちらも switching / no-workspace の fail-closed 契約は同一。
pub fn active_workspace_snapshot(ws_state: &WorkspaceState) -> AppResult<ActiveWorkspaceSnapshot> {
    // ws_state.inner はアクティブ workspace の解決 (Option → Arc<Database>) と
    // switching チェックのためだけに取得し、Arc を呼び出し元へ返す前に必ず解放する。
    // 以前は closure をロック保持下で走らせていたため、ws_state Mutex が DB コール
    // 全体を直列化し、遅いライタの背後で全リーダが待たされていた (アーキ監査
    // 2026-07 の見出し指摘)。db を Arc<Database> にしたことで clone-then-drop
    // でき、実際の DB 直列化は Database 内部の conn: Mutex<Connection> が担う。
    // Phase 5 instrumentation: ws_state lock 取得待ちが 50ms 以上なら警告
    // (以前ほど長く保持しないが、取得待ち自体はリーダ数のシグナルとして残す)。
    let lock_started = std::time::Instant::now();
    {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let ws_lock_ms = lock_started.elapsed().as_millis();
        if ws_lock_ms >= 50 {
            tracing::warn!("with_db ws_state.lock wait={}ms", ws_lock_ms);
        }
        // workspace 切替中の DB アクセスは明示エラーで拒否する (M3)。フロントは
        // 保存失敗 toast + dirty 維持でリトライに任せる。切替を跨いだ write が
        // 別 workspace の DB へ黙って落ちる (UPDATE は 0行 hit の黙示ロスト、
        // INSERT は行混入) のを防ぐ。
        // 安定マーカー "WORKSPACE_SWITCHING" は AppError::WorkspaceSwitching の
        // Display が担う (timelapse recorder の再送抑止 / 保存失敗 toast の文言
        // 差し替え)。TS 側の対の定数は src/features/concurrency/
        // workspaceSwitching.ts の WORKSPACE_SWITCHING_MARKER。変更時は両方同時に。
        if ws_state.switching.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(AppError::WorkspaceSwitching);
        }
        let ws = inner.as_ref().ok_or(AppError::NoWorkspace)?;
        Ok(ActiveWorkspaceSnapshot {
            db: Arc::clone(&ws.db),
            path: ws.path.clone(),
        })
        // inner guard はこのブロック終端で drop = 呼び出し元の DB 操作前に解放。
    }
}

pub fn active_database(ws_state: &WorkspaceState) -> AppResult<Arc<Database>> {
    Ok(active_workspace_snapshot(ws_state)?.db)
}

/// Resolve the currently-open workspace directory without exposing the
/// `WorkspaceState` lock to shell adapters. The same switching fail-closed
/// contract as [`active_database`] applies, so an MCP config can never capture
/// a path midway through a native workspace swap.
pub fn active_workspace_path(ws_state: &WorkspaceState) -> AppResult<PathBuf> {
    Ok(active_workspace_snapshot(ws_state)?.path)
}

/// `tauri::State` を剥がした `with_db` 本体。単体テストや napi 側から
/// `WorkspaceState` を直接組んで検証・実行できるように分離している。
pub fn with_db_state<T>(
    ws_state: &WorkspaceState,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> AppResult<T> {
    let db = active_database(ws_state)?;
    Ok(f(&db)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn workspace_state_with_db() -> WorkspaceState {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace {
                db: Arc::new(db),
                path: PathBuf::from("/tmp/test-ws"),
            })),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        }
    }

    #[test]
    fn with_db_rejects_while_switching() {
        let state = workspace_state_with_db();
        state
            .switching
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let mut ran = false;
        let err = with_db_state(&state, |_db| {
            ran = true;
            Ok(())
        })
        .expect_err("switching 中は明示エラーになるはず");
        assert!(
            err.to_string().contains("WORKSPACE_SWITCHING"),
            "エラー文言にフロント判別用の安定マーカーを含む: {err}"
        );
        assert!(!ran, "switching 中はクロージャを実行しない");

        // フラグ解除後は通常どおり実行される。
        state
            .switching
            .store(false, std::sync::atomic::Ordering::SeqCst);
        let mut ran_after = false;
        with_db_state(&state, |_db| {
            ran_after = true;
            Ok(())
        })
        .expect("switching 解除後は成功する");
        assert!(ran_after);
    }

    #[test]
    fn active_database_rejects_while_switching() {
        let state = workspace_state_with_db();
        state
            .switching
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let err = active_database(&state)
            .err()
            .expect("switching 中は DB を pin できない");
        assert!(err.to_string().contains("WORKSPACE_SWITCHING"));
    }

    #[test]
    fn with_db_releases_inner_lock_before_running_closure() {
        // ③ DB並行 Slice1 の不変条件: with_db_state は f を走らせる前に
        // ws_state.inner ロックを解放しなければならない (監査見出し「ws_state
        // Mutex を DB コール全体で保持」の解消)。同一スレッドからの try_lock
        // 成功で検証する — 旧実装 (ロック保持のまま f) では std::sync::Mutex は
        // 非再帰なので try_lock が WouldBlock で失敗し、このテストは red になる。
        let state = workspace_state_with_db();
        let lock_was_free = with_db_state(&state, |_db| Ok(state.inner.try_lock().is_ok()))
            .expect("workspace が開いていれば成功する");
        assert!(
            lock_was_free,
            "with_db_state は f を走らせる前に ws_state.inner ロックを解放すること"
        );
    }

    #[test]
    fn with_db_errors_when_no_workspace_open() {
        let state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let err = with_db_state(&state, |_db| Ok(())).expect_err("未オープンはエラー");
        assert!(err.to_string().contains("No workspace is open"));
    }

    #[test]
    fn active_database_errors_when_no_workspace_open() {
        let state = WorkspaceState {
            inner: Mutex::new(None),
            switching: std::sync::atomic::AtomicBool::new(false),
            open_lock: Mutex::new(()),
        };
        let err = active_database(&state)
            .err()
            .expect("未オープンは DB を pin できない");
        assert!(err.to_string().contains("No workspace is open"));
    }

    #[test]
    fn active_workspace_path_returns_the_pinned_directory() {
        let state = workspace_state_with_db();
        assert_eq!(
            active_workspace_path(&state).expect("workspace path"),
            PathBuf::from("/tmp/test-ws")
        );
    }

    #[test]
    fn active_workspace_path_rejects_during_switch() {
        let state = workspace_state_with_db();
        state
            .switching
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let error = active_workspace_path(&state).expect_err("switching must fail closed");
        assert!(error.to_string().contains("WORKSPACE_SWITCHING"));
    }

    #[test]
    fn active_workspace_snapshot_pins_database_and_path_from_one_workspace() {
        let state = workspace_state_with_db();
        let snapshot = active_workspace_snapshot(&state).expect("workspace snapshot");

        let replacement = Database::new(Path::new(":memory:")).expect("replacement db");
        *state.inner.lock().expect("workspace lock") = Some(ActiveWorkspace {
            db: Arc::new(replacement),
            path: PathBuf::from("/tmp/replacement-ws"),
        });

        assert_eq!(snapshot.path, PathBuf::from("/tmp/test-ws"));
        assert!(!Arc::ptr_eq(
            &snapshot.db,
            &active_workspace_snapshot(&state)
                .expect("replacement snapshot")
                .db,
        ));
    }
}
