//! workspace 状態 (旧 `src-tauri/src/commands/mod.rs` から Electron 移行
//! Phase 2 S1 で移動)。tauri:: 非依存 — Tauri 側は `app.manage(...)` で、
//! napi 側は `Backend` の `AppState` でこの型をそのまま保持する。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};
use crate::recovery::SafeModeState;
use crate::workspace_lease::WorkspaceLease;
use crate::workspace_lifecycle::{
    LifecycleState, WorkspaceLifecycleCompatibilityView, WorkspaceLifecycleCore,
};
use crate::Database;

/// Inseparable workspace DB authority: a live [`Database`] handle always keeps
/// the matching shared file lease alive for the same duration.
///
/// Background tasks must pin [`Arc<WorkspaceAuthority>`] (via
/// [`active_workspace_snapshot`] / [`active_database`]), never a bare
/// `Arc<Database>`. Dropping the last authority Arc releases the lease and
/// allows cross-process exclusive migration / restore.
pub struct WorkspaceAuthority {
    db: Database,
    path: PathBuf,
    lease: WorkspaceLease,
    identity: u64,
    nir_chronicle_index:
        crate::narrative_extraction::nir1_chronicle_index::NirChronicleIndexRuntime,
}

static NEXT_WORKSPACE_AUTHORITY_ID: AtomicU64 = AtomicU64::new(1);

impl WorkspaceAuthority {
    pub fn new(db: Database, path: PathBuf, lease: WorkspaceLease) -> Self {
        let identity = NEXT_WORKSPACE_AUTHORITY_ID.fetch_add(1, Ordering::Relaxed);
        let nir_chronicle_index =
            crate::narrative_extraction::nir1_chronicle_index::NirChronicleIndexRuntime::new(
                &db, identity,
            );
        Self {
            db,
            path,
            lease,
            identity,
            nir_chronicle_index,
        }
    }

    pub fn db(&self) -> &Database {
        &self.db
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn lease(&self) -> &WorkspaceLease {
        &self.lease
    }

    /// Monotonic process-local authority instance identity. Unlike an Arc
    /// address, it cannot be reused when a same-path restore drops and
    /// replaces the previous authority.
    pub fn identity(&self) -> u64 {
        self.identity
    }

    pub fn nir_chronicle_index_runtime(
        &self,
    ) -> &crate::narrative_extraction::nir1_chronicle_index::NirChronicleIndexRuntime {
        &self.nir_chronicle_index
    }

    /// Build authority for tests / fixtures (acquires a shared lease on `path`).
    pub fn from_database_for_test(db: Database, path: PathBuf) -> AppResult<Arc<Self>> {
        std::fs::create_dir_all(&path).map_err(anyhow::Error::from)?;
        let lease = crate::workspace_lease::try_acquire_shared(&path)?;
        Ok(Arc::new(Self::new(db, path, lease)))
    }
}

impl std::ops::Deref for WorkspaceAuthority {
    type Target = Database;

    fn deref(&self) -> &Database {
        &self.db
    }
}

/// Pinned workspace DB. Cloning keeps both the SQLite handle and the shared
/// lease alive — the Gate A invariant for long-lived background work.
pub type PinnedWorkspaceDb = Arc<WorkspaceAuthority>;

/// Holds the currently-open workspace authority.
/// Wrapped in Option so it can be None before a workspace is opened.
///
/// `authority` は `Arc` にして `with_db_state` が clone-then-drop できる
/// ようにしている: ws_state.inner ロックを SQL 実行の前に解放し、遅いライタ
/// の背後で全リーダ/ライタが直列化されるのを防ぐ。swap 中に発行済みの
/// コマンドは pre-swap で clone した Arc (旧 authority) に着弾するので、新 DB
/// への混入は起きない。旧 authority を保持している間は shared lease も生き、
/// 別プロセスの exclusive migration を阻む。
pub struct ActiveWorkspace {
    pub authority: PinnedWorkspaceDb,
}

impl ActiveWorkspace {
    pub fn new(authority: PinnedWorkspaceDb) -> Self {
        Self { authority }
    }

    pub fn db(&self) -> &Database {
        self.authority.db()
    }

    pub fn path(&self) -> &Path {
        self.authority.path()
    }
}

pub struct WorkspaceState {
    pub inner: Mutex<Option<ActiveWorkspace>>,
    /// Restore-only Safe Mode session (mutually exclusive with `inner` authority).
    pub safe_mode: SafeModeState,
    /// `open_workspace` 実行中フラグ。DB コマンドの async 化 (M3) で
    /// open_workspace と他コマンドが真に並行するようになったため、切替中の
    /// DB アクセスを `with_db` で明示エラーにする (swap を跨いだ write が
    /// 切替後の別 workspace の DB へ黙って落ちるより遥かに良い失敗モード)。
    /// set/reset は open_workspace 内の RAII ガードが行う。
    pub switching: WorkspaceLifecycleCompatibilityView,
    /// `open_workspace` 自体を直列化する番兵。並行 open による同一 DB への
    /// 併走 migrate (add_column_if_missing の check-then-act) と二重
    /// VACUUM INTO を防ぐ。ガードは絶対に await を跨がないこと
    /// (std::sync::MutexGuard は !Send)。
    pub open_lock: Mutex<()>,
}

impl WorkspaceState {
    /// Return the shared lifecycle core behind the legacy switching view.
    ///
    /// Existing callers still use `switching.load/store` until C4 removes the
    /// compatibility path, but they now observe the same state storage as
    /// lifecycle owners.
    pub fn lifecycle_core(&self) -> WorkspaceLifecycleCore {
        self.switching.core()
    }
}

/// Authority captured under one `WorkspaceState::inner` lock.
/// Long-running shell adapters keep this value instead of resolving the
/// active workspace again after entering a blocking queue. The pinned Arc
/// keeps the shared lease alive for the task lifetime.
#[derive(Clone)]
pub struct ActiveWorkspaceSnapshot {
    pub authority: PinnedWorkspaceDb,
    /// Keeps the lifecycle core aware of the pinned DB operation until this
    /// snapshot (and any intentional clone) is dropped.
    _participant: crate::workspace_lifecycle::WorkspaceParticipant,
}

impl ActiveWorkspaceSnapshot {
    pub fn db(&self) -> &PinnedWorkspaceDb {
        &self.authority
    }

    pub fn path(&self) -> &Path {
        self.authority.path()
    }
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

/// 現在 workspace の authority を1回だけ解決する。
///
/// 長寿命の background task は開始時にこの `Arc` を保持し、workspace switch 後も
/// 同じ DB（と shared lease）へ完了/失敗を保存する。通常の短命 command は
/// `with_db_state` 経由で毎回解決する。どちらも switching / no-workspace の
/// fail-closed 契約は同一。
pub fn active_workspace_snapshot(ws_state: &WorkspaceState) -> AppResult<ActiveWorkspaceSnapshot> {
    let participant = ws_state.lifecycle_core().begin_workspace_participant()?;
    let lock_started = std::time::Instant::now();
    {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let ws_lock_ms = lock_started.elapsed().as_millis();
        if ws_lock_ms >= 50 {
            tracing::warn!("with_db ws_state.lock wait={}ms", ws_lock_ms);
        }
        let lifecycle_state = ws_state
            .switching
            .core()
            .snapshot()
            .map_err(|error| anyhow::anyhow!("workspace lifecycle state unavailable: {error}"))?
            .state;
        if ws_state.switching.load(std::sync::atomic::Ordering::SeqCst)
            || matches!(lifecycle_state, LifecycleState::Transition { .. })
        {
            return Err(AppError::WorkspaceSwitching);
        }
        if ws_state.safe_mode.is_active() {
            return Err(AppError::SafeModeActive);
        }
        let ws = inner.as_ref().ok_or(AppError::NoWorkspace)?;
        let LifecycleState::Ready(binding) = lifecycle_state else {
            // The Tauri shell is a frozen compatibility surface. Its test
            // fixtures and legacy startup path install an already-verified
            // authority before the Electron lifecycle adapter can publish a
            // Ready projection. Preserve that narrow direct-owner path while
            // keeping explicit Transition/RecoveryRequired/Closed states
            // fail-closed.
            if matches!(lifecycle_state, LifecycleState::NoWorkspace) {
                if let Some(ws) = inner.as_ref() {
                    return Ok(ActiveWorkspaceSnapshot {
                        authority: Arc::clone(&ws.authority),
                        _participant: participant,
                    });
                }
            }
            // Closed, RecoveryRequired, and an uninitialized NoWorkspace
            // projection must never leak an already-held authority to a
            // normal DB command.  Only the exact Ready binding may be pinned.
            return Err(match lifecycle_state {
                LifecycleState::NoWorkspace => AppError::NoWorkspace,
                LifecycleState::Closed | LifecycleState::RecoveryRequired { .. } => {
                    AppError::WorkspaceSwitching
                }
                LifecycleState::Transition { .. } | LifecycleState::Ready(_) => {
                    AppError::WorkspaceSwitching
                }
            });
        };
        if binding.authority_instance != ws.authority.identity() {
            return Err(AppError::Anyhow(anyhow::anyhow!(
                "NEX_WORKSPACE_BINDING_CHANGED: lifecycle Ready binding does not match the active authority"
            )));
        }
        Ok(ActiveWorkspaceSnapshot {
            authority: Arc::clone(&ws.authority),
            _participant: participant,
        })
    }
}

/// Pin the active workspace authority (Database + shared lease).
///
/// Named for historical call sites; the returned Arc is [`WorkspaceAuthority`],
/// not a bare Database.
pub fn active_database(ws_state: &WorkspaceState) -> AppResult<PinnedWorkspaceDb> {
    Ok(active_workspace_snapshot(ws_state)?.authority)
}

/// Resolve the currently-open workspace directory without exposing the
/// `WorkspaceState` lock to shell adapters. The same switching fail-closed
/// contract as [`active_database`] applies, so an MCP config can never capture
/// a path midway through a native workspace swap.
pub fn active_workspace_path(ws_state: &WorkspaceState) -> AppResult<PathBuf> {
    Ok(active_workspace_snapshot(ws_state)?.path().to_path_buf())
}

/// `tauri::State` を剥がした `with_db` 本体。単体テストや napi 側から
/// `WorkspaceState` を直接組んで検証・実行できるように分離している。
pub fn with_db_state<T>(
    ws_state: &WorkspaceState,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> AppResult<T> {
    // Register before resolving the active authority. A concurrent
    // transition or shutdown therefore cannot publish physical replacement or
    // Closed in the small gap between pinning the Arc and entering the DB
    // closure. The participant is independent of foreground/maintenance
    // scheduling and is released after the caller's transaction returns.
    let _participant = ws_state.lifecycle_core().begin_workspace_participant()?;
    let authority = active_database(ws_state)?;
    Ok(f(authority.db())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_lifecycle::LiveBinding;
    use std::path::Path;

    fn workspace_state_with_db() -> WorkspaceState {
        let path =
            std::env::temp_dir().join(format!("grimodex-state-test-ws-{}", uuid::Uuid::new_v4()));
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, path).expect("test authority");
        let state = WorkspaceState {
            inner: Mutex::new(Some(ActiveWorkspace::new(authority))),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let authority = state
            .inner
            .lock()
            .expect("workspace lock")
            .as_ref()
            .expect("test authority")
            .authority
            .clone();
        state
            .switching
            .core()
            .set_ready(LiveBinding::new(
                authority.path().to_string_lossy(),
                format!("test-workspace:{}", authority.identity()),
                authority.identity(),
                0,
            ))
            .expect("test lifecycle ready");
        state
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
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
            open_lock: Mutex::new(()),
        };
        let err = with_db_state(&state, |_db| Ok(())).expect_err("未オープンはエラー");
        assert!(err.to_string().contains("No workspace is open"));
    }

    #[test]
    fn active_database_errors_when_no_workspace_open() {
        let state = WorkspaceState {
            inner: Mutex::new(None),
            safe_mode: crate::recovery::SafeModeState::default(),
            switching: WorkspaceLifecycleCompatibilityView::new(false),
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
        let expected = active_workspace_snapshot(&state)
            .expect("snapshot")
            .path()
            .to_path_buf();
        assert_eq!(
            active_workspace_path(&state).expect("workspace path"),
            expected
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
    fn active_workspace_snapshot_pins_authority_including_lease() {
        let state = workspace_state_with_db();
        let snapshot = active_workspace_snapshot(&state).expect("workspace snapshot");
        let original_path = snapshot.path().to_path_buf();

        let replacement_path = std::env::temp_dir().join(format!(
            "grimodex-state-replacement-{}",
            uuid::Uuid::new_v4()
        ));
        let replacement = Database::new(Path::new(":memory:")).expect("replacement db");
        let replacement_authority =
            WorkspaceAuthority::from_database_for_test(replacement, replacement_path)
                .expect("replacement authority");
        *state.inner.lock().expect("workspace lock") =
            Some(ActiveWorkspace::new(replacement_authority));

        assert_eq!(snapshot.path(), original_path.as_path());
        let error = match active_workspace_snapshot(&state) {
            Ok(_) => panic!("a direct authority replacement must fail closed until activation"),
            Err(error) => error,
        };
        assert!(error
            .to_string()
            .contains("NEX_WORKSPACE_BINDING_CHANGED"));
        // Pinned snapshot still holds the original shared lease.
        let exclusive = crate::workspace_lease::acquire_exclusive(
            &original_path,
            std::time::Duration::from_millis(50),
        );
        assert!(
            exclusive.is_err(),
            "snapshot must keep shared lease alive after workspace swap"
        );
        drop(snapshot);
    }
}
