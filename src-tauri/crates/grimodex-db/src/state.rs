//! workspace 状態 (旧 `src-tauri/src/commands/mod.rs` から Electron 移行
//! Phase 2 S1 で移動)。tauri:: 非依存 — Tauri 側は `app.manage(...)` で、
//! napi 側は `Backend` の `AppState` でこの型をそのまま保持する。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};
use crate::recovery::SafeModeState;
use crate::workspace_lease::WorkspaceLease;
use crate::workspace_lifecycle::{
    LifecycleDiagnostic, LifecycleError, LifecycleState, WorkspaceLifecycleCompatibilityView,
    WorkspaceLifecycleCore, WorkspaceParticipant,
};
use crate::Database;

/// Inseparable workspace DB authority: a live [`Database`] handle always keeps
/// the matching shared file lease alive for the same duration.
///
/// Background tasks must pin [`Arc<WorkspaceAuthority>`] (via
/// [`active_workspace_snapshot`] / [`active_database`]), never a bare
/// `Arc<Database>`. Dropping the last authority Arc releases the DB/index;
/// a C-query child claim may independently retain its exact shared lease/slot
/// fence after READY through retirement, or until process exit if quarantined.
pub struct WorkspaceAuthority {
    db: Database,
    path: PathBuf,
    retention: Arc<WorkspaceRetentionFence>,
    nir_chronicle_index:
        crate::narrative_extraction::nir1_chronicle_index::NirChronicleIndexRuntime,
}

/// A C-query child claim keeps the exact file lease and one-child slot alive
/// independently of DB/index authority from READY through retirement, or
/// process-lifetime if cleanup cannot be proved.
struct WorkspaceRetentionFence {
    lease: WorkspaceLease,
    identity: u64,
    c_query_child_claimed: AtomicBool,
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
            retention: Arc::new(WorkspaceRetentionFence {
                lease,
                identity,
                c_query_child_claimed: AtomicBool::new(false),
            }),
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
        &self.retention.lease
    }

    /// Monotonic process-local authority instance identity. Unlike an Arc
    /// address, it cannot be reused when a same-path restore drops and
    /// replaces the previous authority.
    pub fn identity(&self) -> u64 {
        self.retention.identity
    }

    /// Stable identity of this authority's opened SQLite main database file.
    /// This stays internal to Native lifecycle checks and is never serialized.
    #[doc(hidden)]
    pub fn main_database_file_identity(&self) -> anyhow::Result<String> {
        let path = self.db.with_conn(|conn| {
            let path: String = conn.query_row(
                "SELECT file FROM pragma_database_list WHERE name = 'main'",
                [],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                !path.trim().is_empty(),
                "physical main database identity is unavailable"
            );
            Ok(PathBuf::from(path))
        })?;
        Self::database_file_identity_for_path(&path)
    }

    /// Capture a target's stable file identity before Native Open admission.
    /// Missing/unavailable identity is handled fail-closed by a live quarantine.
    #[doc(hidden)]
    pub fn database_file_identity_for_path(path: &Path) -> anyhow::Result<String> {
        #[cfg(not(any(unix, windows)))]
        anyhow::bail!("physical main database identity is unavailable on this platform");

        #[cfg(any(unix, windows))]
        crate::narrative_extraction::sqlite_database_file_identity(path)
    }

    pub(crate) fn claim_c_query_child(self: &Arc<Self>) -> Option<CQueryChildClaim> {
        self.retention
            .c_query_child_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| CQueryChildClaim {
                retention: Arc::clone(&self.retention),
            })
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

/// Never released by Drop: only a dropped result lease plus proved child
/// exit+EOF+reader-join allow the owner to reopen admission. After READY this
/// exact lease/slot fence remains pinned independently of the DB/index
/// authority; cleanup-unproved detachment may keep it process-lifetime.
pub(crate) struct CQueryChildClaim {
    retention: Arc<WorkspaceRetentionFence>,
}
impl CQueryChildClaim {
    #[cfg(test)]
    pub(crate) fn is_held_for_test(&self) -> bool {
        self.retention.c_query_child_claimed.load(Ordering::Acquire)
    }

    pub(crate) fn release(self) {
        self.retention
            .c_query_child_claimed
            .store(false, Ordering::Release);
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
    /// Exact Ready binding captured with this participant, absent only on the
    /// frozen legacy NoWorkspace compatibility path.
    binding: Option<crate::workspace_lifecycle::LiveBinding>,
    /// Keeps the lifecycle core aware of the pinned DB operation until this
    /// snapshot (and any intentional clone) is dropped.
    _participant: crate::workspace_lifecycle::WorkspaceParticipant,
}

impl ActiveWorkspaceSnapshot {
    pub fn db(&self) -> &PinnedWorkspaceDb {
        &self.authority
    }

    /// Borrow the lifecycle participant paired with this exact authority.
    /// Callers must not replace it with a participant acquired after a
    /// workspace transition; the participant has no independent binding ID.
    pub(crate) fn participant(&self) -> &crate::workspace_lifecycle::WorkspaceParticipant {
        &self._participant
    }

    pub(crate) fn check_current_binding(&self) -> anyhow::Result<()> {
        let binding = self
            .binding
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NEX_WORKSPACE_BINDING_UNAVAILABLE"))?;
        self._participant.with_current_binding(binding, || ())?;
        Ok(())
    }

    pub(crate) fn detach_c_query_quarantine(
        &self,
    ) -> Option<crate::workspace_lifecycle::WorkspaceQuarantineFence> {
        self._participant
            .detach_c_query_quarantine(self.binding.as_ref()?)
    }

    /// Transfer the exact binding and participant after the C-query reader has
    /// published READY, then drop only this snapshot's authority reference.
    pub(crate) fn into_c_query_ready_owner(self) -> Result<CQueryReadyWorkspace, Self> {
        let Self {
            authority,
            binding,
            _participant,
        } = self;
        let Some(binding) = binding else {
            return Err(Self {
                authority,
                binding: None,
                _participant,
            });
        };
        drop(authority);
        Ok(CQueryReadyWorkspace {
            binding,
            _participant,
        })
    }

    /// Drop this snapshot's authority/binding references but retain its exact
    /// lifecycle participant only while the core still counts it as a safe
    /// pre-I/O drain barrier. Refusal returns the intact snapshot.
    pub(crate) fn into_c_query_fallback_participant(
        self,
    ) -> Result<crate::workspace_lifecycle::WorkspaceParticipant, Self> {
        let Self {
            authority,
            binding,
            _participant,
        } = self;
        match _participant.try_retain_for_c_query_fallback() {
            Ok(_participant) => Ok(_participant),
            Err(_participant) => Err(Self {
                authority,
                binding,
                _participant,
            }),
        }
    }

    pub fn path(&self) -> &Path {
        self.authority.path()
    }
}

/// The exact C-query binding and lifecycle barrier retained after READY,
/// without pinning the workspace DB/index authority.
pub(crate) struct CQueryReadyWorkspace {
    binding: crate::workspace_lifecycle::LiveBinding,
    _participant: crate::workspace_lifecycle::WorkspaceParticipant,
}

impl CQueryReadyWorkspace {
    pub(crate) fn check_current_binding(&self) -> anyhow::Result<()> {
        self._participant
            .with_current_binding(&self.binding, || ())?;
        Ok(())
    }

    pub(crate) fn detach_c_query_quarantine(
        &self,
    ) -> Option<crate::workspace_lifecycle::WorkspaceQuarantineFence> {
        self._participant.detach_c_query_quarantine(&self.binding)
    }

    pub(crate) fn into_c_query_fallback_participant(
        self,
    ) -> Result<crate::workspace_lifecycle::WorkspaceParticipant, Self> {
        let Self {
            binding,
            _participant,
        } = self;
        match _participant.try_retain_for_c_query_fallback() {
            Ok(_participant) => Ok(_participant),
            Err(_participant) => Err(Self {
                binding,
                _participant,
            }),
        }
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
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DbLifecycleRejectionSite {
    DatabaseParticipant,
    AuthorityParticipant,
    AuthorityProjection,
    /// The actual compatibility load occurs after the recorded core snapshot.
    AuthorityCompatibility,
}

type RejectionObserver<'a> =
    Option<&'a mut dyn FnMut(DbLifecycleRejectionSite, LifecycleDiagnostic)>;

fn db_participant(
    ws_state: &WorkspaceState,
    site: DbLifecycleRejectionSite,
    observer: &mut RejectionObserver<'_>,
) -> AppResult<WorkspaceParticipant> {
    let core = ws_state.lifecycle_core();
    let result = match observer.as_mut() {
        Some(on_rejection) => core.begin_workspace_participant_diagnosed(|evidence| {
            on_rejection(site, evidence);
        }),
        None => core.begin_workspace_participant(),
    };
    result.map_err(|error| match error {
        LifecycleError::ActiveOperations => AppError::WorkspaceSwitching,
        other => AppError::from(other),
    })
}

pub fn active_workspace_snapshot(ws_state: &WorkspaceState) -> AppResult<ActiveWorkspaceSnapshot> {
    active_workspace_snapshot_inner(ws_state, None)
}

fn active_workspace_snapshot_inner(
    ws_state: &WorkspaceState,
    mut observer: RejectionObserver<'_>,
) -> AppResult<ActiveWorkspaceSnapshot> {
    let participant = db_participant(
        ws_state,
        DbLifecycleRejectionSite::AuthorityParticipant,
        &mut observer,
    )?;
    resolve_workspace_snapshot(ws_state, participant, observer)
}

fn resolve_workspace_snapshot(
    ws_state: &WorkspaceState,
    participant: crate::workspace_lifecycle::WorkspaceParticipant,
    mut observer: RejectionObserver<'_>,
) -> AppResult<ActiveWorkspaceSnapshot> {
    let lock_started = std::time::Instant::now();
    {
        let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let ws_lock_ms = lock_started.elapsed().as_millis();
        if ws_lock_ms >= 50 {
            tracing::warn!("with_db ws_state.lock wait={}ms", ws_lock_ms);
        }
        let core = ws_state.switching.core();
        let (snapshot, mut evidence) = if observer.is_some() {
            core.snapshot_with_diagnostic()
                .map(|(view, evidence)| (view, Some(evidence)))
        } else {
            core.snapshot().map(|view| (view, None))
        }
        .map_err(|error| anyhow::anyhow!("workspace lifecycle state unavailable: {error}"))?;
        let lifecycle_state = snapshot.state;
        let compatibility_switching = ws_state.switching.load(std::sync::atomic::Ordering::SeqCst);
        if let Some(evidence) = evidence.as_mut() {
            evidence.compatibility_switching = Some(compatibility_switching);
        }
        if compatibility_switching
            || matches!(lifecycle_state, LifecycleState::Transition { .. })
        {
            drop(inner);
            if let (Some(on_rejection), Some(evidence)) = (observer.as_mut(), evidence) {
                on_rejection(
                    if compatibility_switching { DbLifecycleRejectionSite::AuthorityCompatibility }
                    else { DbLifecycleRejectionSite::AuthorityProjection },
                    evidence,
                );
            }
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
                        binding: None,
                        _participant: participant,
                    });
                }
            }
            // Closed, RecoveryRequired, and an uninitialized NoWorkspace
            // projection must never leak an already-held authority to a
            // normal DB command.  Only the exact Ready binding may be pinned.
            drop(inner);
            if matches!(
                lifecycle_state,
                LifecycleState::Closed | LifecycleState::RecoveryRequired { .. }
            ) {
                if let (Some(on_rejection), Some(evidence)) = (observer.as_mut(), evidence) {
                    on_rejection(DbLifecycleRejectionSite::AuthorityProjection, evidence);
                }
            }
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
            binding: Some(binding),
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
    with_db_state_inner(ws_state, f, None)
}

/// Failure-only hook for the Native append boundary. It observes the same
/// admission/projection decisions without another snapshot or changing errors.
pub fn with_db_state_diagnosed<T>(
    ws_state: &WorkspaceState,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
    mut on_rejection: impl FnMut(DbLifecycleRejectionSite, LifecycleDiagnostic),
) -> AppResult<T> {
    with_db_state_inner(ws_state, f, Some(&mut on_rejection))
}

fn with_db_state_inner<T>(
    ws_state: &WorkspaceState,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
    mut observer: RejectionObserver<'_>,
) -> AppResult<T> {
    // Register before resolving the active authority. A concurrent
    // transition or shutdown therefore cannot publish physical replacement or
    // Closed in the small gap between pinning the Arc and entering the DB
    // closure. The participant is independent of foreground/maintenance
    // scheduling and is released after the caller's transaction returns.
    let _participant = db_participant(
        ws_state,
        DbLifecycleRejectionSite::DatabaseParticipant,
        &mut observer,
    )?;
    let authority = active_workspace_snapshot_inner(ws_state, observer)?.authority;
    Ok(f(authority.db())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_lifecycle::LiveBinding;
    use std::path::Path;

    #[test]
    fn diagnosed_db_ready_is_silent_and_keeps_existing_participant_lifetime() {
        let state = workspace_state_with_db();
        let result = with_db_state_diagnosed(
            &state,
            |_db| {
                assert_eq!(state.lifecycle_core().workspace_participant_count()?, 1);
                Ok(42)
            },
            |_, _| panic!("Ready does not log"),
        );
        assert_eq!(result.expect("Ready DB"), 42);
        assert_eq!(
            state
                .lifecycle_core()
                .workspace_participant_count()
                .expect("released"),
            0
        );
    }

    #[test]
    fn diagnosed_db_compatibility_rejection_records_the_actual_predicate() {
        let state = workspace_state_with_db();
        let core = state.lifecycle_core();
        state.switching.store(true, std::sync::atomic::Ordering::SeqCst);
        let error = with_db_state_diagnosed(&state,
            |_db| -> anyhow::Result<()> { panic!("no DB after compatibility refusal") },
            |site, evidence| {
                assert!(matches!(site, DbLifecycleRejectionSite::AuthorityCompatibility));
                assert_eq!(evidence.state, crate::workspace_lifecycle::DiagnosticLifecycleState::Ready);
                assert_eq!(evidence.projected_state, Some(crate::workspace_lifecycle::DiagnosticLifecycleState::Transition));
                assert_eq!(evidence.compatibility_switching, Some(true));
                assert!(state.inner.try_lock().is_ok());
            },
        ).expect_err("compatibility refusal");
        assert!(matches!(error, AppError::WorkspaceSwitching));
        assert_eq!(core.workspace_participant_count().expect("released"), 0);
    }

    #[test]
    fn diagnosed_db_refusal_never_runs_db_body() {
        let state = workspace_state_with_db();
        let core = state.lifecycle_core();
        core.begin_transition(crate::workspace_lifecycle::AdmissionKind::Open)
            .expect("Transition");
        let mut calls = 0;
        let error = with_db_state_diagnosed(
            &state,
            |_db| -> anyhow::Result<()> { panic!("no DB after refusal") },
            |site, evidence| {
                assert!(matches!(
                    site,
                    DbLifecycleRejectionSite::DatabaseParticipant
                ));
                assert_eq!(
                    evidence.state,
                    crate::workspace_lifecycle::DiagnosticLifecycleState::Transition
                );
                assert!(state.inner.try_lock().is_ok());
                assert_eq!(
                    core.snapshot().expect("unlocked observer").revision,
                    evidence.revision
                );
                calls += 1;
            },
        )
        .expect_err("refusal");
        assert!(matches!(error, AppError::WorkspaceSwitching));
        assert_eq!(calls, 1);
        assert_eq!(
            core.workspace_participant_count().expect("no participant"),
            0
        );
    }

    #[test]
    fn diagnosed_inner_participant_and_projection_races_keep_actual_refusal_evidence() {
        for projection_race in [false, true] {
            let state = workspace_state_with_db();
            let core = state.lifecycle_core();
            let outer = core
                .begin_workspace_participant()
                .expect("outer participant");
            let inner = projection_race.then(|| {
                core.begin_workspace_participant()
                    .expect("inner participant")
            });
            if projection_race {
                let mut permit = match core.admit_maintenance_permit().expect("maintenance") {
                    crate::workspace_lifecycle::PermitAdmission::Admitted(permit) => permit,
                    _ => panic!("maintenance admission"),
                };
                permit.start().expect("Start");
                permit.mark_joined().expect("Join");
                permit.transfer_to_recovery().expect("recovery after both participant admissions");
            } else {
                core.begin_transition(crate::workspace_lifecycle::AdmissionKind::Open)
                    .expect("transition after outer admission");
            }
            let mut calls = 0;
            let mut observer = |site, evidence: LifecycleDiagnostic| {
                assert!(if projection_race {
                    matches!(site, DbLifecycleRejectionSite::AuthorityProjection)
                } else {
                    matches!(site, DbLifecycleRejectionSite::AuthorityParticipant)
                });
                assert_eq!(evidence.state, if projection_race {
                    crate::workspace_lifecycle::DiagnosticLifecycleState::RecoveryRequired
                } else {
                    crate::workspace_lifecycle::DiagnosticLifecycleState::Transition
                });
                assert!(
                    state.inner.try_lock().is_ok(),
                    "observer does not hold workspace lock"
                );
                assert_eq!(
                    core.snapshot().expect("core unlock").revision,
                    evidence.revision
                );
                calls += 1;
            };
            let result = if let Some(inner) = inner {
                resolve_workspace_snapshot(&state, inner, Some(&mut observer))
            } else {
                active_workspace_snapshot_inner(&state, Some(&mut observer))
            };
            assert!(matches!(result, Err(AppError::WorkspaceSwitching)));
            assert_eq!(calls, 1);
            assert_eq!(
                core.workspace_participant_count().expect("inner released"),
                1
            );
            drop(outer);
            assert_eq!(
                core.workspace_participant_count().expect("outer released"),
                0
            );
        }
    }

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
    fn active_database_maps_core_transition_to_workspace_switching() {
        let state = workspace_state_with_db();
        let outcome = state
            .switching
            .core()
            .begin_transition(crate::workspace_lifecycle::AdmissionKind::Open)
            .expect("transition admission");
        assert!(matches!(
            outcome,
            crate::workspace_lifecycle::AdmissionOutcome::Admitted(_)
        ));

        let err = active_database(&state)
            .err()
            .expect("ordinary DB access must be retryable during a core transition");
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

    #[cfg(unix)]
    #[test]
    fn main_database_file_identity_matches_directory_symlink_alias() -> anyhow::Result<()> {
        let path = std::env::temp_dir().join(format!(
            "grimodex-state-file-identity-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path)?;
        let db = Database::new(&path.join("grimodex.db"))?;
        let authority = WorkspaceAuthority::from_database_for_test(db, path.clone())?;
        let identity = authority.main_database_file_identity()?;
        let alias = path.with_file_name(format!(
            "{}-alias",
            path.file_name().expect("unique temp dir").to_string_lossy()
        ));
        std::os::unix::fs::symlink(&path, &alias)?;
        let alias_path = alias.join("grimodex.db");
        let alias_identity = WorkspaceAuthority::database_file_identity_for_path(&alias_path)?;
        assert_eq!(identity, alias_identity);
        let hard_link = path.with_file_name(format!(
            "{}-hard-link.db",
            path.file_name().expect("unique temp dir").to_string_lossy()
        ));
        std::fs::hard_link(path.join("grimodex.db"), &hard_link)?;
        let hard_link_identity = WorkspaceAuthority::database_file_identity_for_path(&hard_link)?;
        assert_eq!(identity, hard_link_identity);

        drop(authority);
        std::fs::remove_file(alias)?;
        std::fs::remove_file(hard_link)?;
        std::fs::remove_dir_all(path)?;
        Ok(())
    }

    #[test]
    fn child_claim_retains_file_lease_without_retaining_database_authority() {
        let path = std::env::temp_dir().join(format!(
            "grimodex-state-retention-test-{}",
            uuid::Uuid::new_v4()
        ));
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        let authority =
            WorkspaceAuthority::from_database_for_test(db, path.clone()).expect("test authority");
        let weak = Arc::downgrade(&authority);
        let claim = authority.claim_c_query_child().expect("child slot");
        assert!(authority.claim_c_query_child().is_none());

        drop(authority);
        assert!(
            weak.upgrade().is_none(),
            "claim must not retain DB/index authority"
        );
        assert!(
            crate::workspace_lease::acquire_exclusive(&path, std::time::Duration::ZERO).is_err(),
            "detached child claim must retain its original shared file lease"
        );

        claim.release();
        crate::workspace_lease::acquire_exclusive(&path, std::time::Duration::ZERO)
            .expect("proved claim release drops the shared file lease");
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn active_workspace_snapshot_shares_live_binding_payloads() {
        let state = workspace_state_with_db();
        let (locator, authority_instance) = {
            let workspace = state.inner.lock().expect("workspace lock");
            let authority = &workspace.as_ref().expect("active workspace").authority;
            (
                authority.path().to_string_lossy().into_owned(),
                authority.identity(),
            )
        };
        let workspace_id = "w".repeat(16_384);
        let binding = LiveBinding::new(locator, workspace_id, authority_instance, 1);
        let core = state.lifecycle_core();
        core.set_ready(binding.clone())
            .expect("long-ID binding ready");

        let snapshot = active_workspace_snapshot(&state).expect("workspace snapshot");
        let captured = snapshot.binding.as_ref().expect("Ready binding");
        let lifecycle_snapshot = core.snapshot().expect("lifecycle snapshot");
        let LifecycleState::Ready(ready_binding) = lifecycle_snapshot.state else {
            panic!("expected Ready binding");
        };

        assert_eq!(captured, &binding);
        assert_eq!(captured.workspace_id.len(), 16_384);
        assert!(Arc::ptr_eq(&binding.locator, &captured.locator));
        assert!(Arc::ptr_eq(&binding.workspace_id, &captured.workspace_id));
        assert!(Arc::ptr_eq(&ready_binding.locator, &captured.locator));
        assert!(Arc::ptr_eq(
            &ready_binding.workspace_id,
            &captured.workspace_id
        ));
        let separately_allocated = LiveBinding::new(
            captured.locator.as_ref(),
            captured.workspace_id.as_ref(),
            authority_instance,
            1,
        );
        assert_eq!(captured, &separately_allocated);
        assert!(!Arc::ptr_eq(
            &captured.workspace_id,
            &separately_allocated.workspace_id
        ));

        let serialized = serde_json::to_value(captured).expect("serialize binding");
        let fields = serialized.as_object().expect("binding object");
        assert_eq!(fields.len(), 4);
        assert_eq!(
            serialized["locator"].as_str(),
            Some(captured.locator.as_ref())
        );
        assert_eq!(
            serialized["workspace_id"].as_str(),
            Some(captured.workspace_id.as_ref())
        );
        assert_eq!(
            serialized["authority_instance"].as_u64(),
            Some(authority_instance)
        );
        assert_eq!(serialized["recovery_generation"].as_u64(), Some(1));
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
        assert!(error.to_string().contains("NEX_WORKSPACE_BINDING_CHANGED"));
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

    #[test]
    fn c_query_fallback_split_drops_owner_authority_and_keeps_transition_barrier() {
        let state = workspace_state_with_db();
        let core = state.lifecycle_core();
        let authority_weak = {
            let workspace = state.inner.lock().expect("workspace lock");
            Arc::downgrade(&workspace.as_ref().expect("active workspace").authority)
        };
        let snapshot = active_workspace_snapshot(&state).expect("snapshot");
        let participant = match snapshot.into_c_query_fallback_participant() {
            Ok(participant) => participant,
            Err(_) => panic!("live participant must be transferable"),
        };
        assert_eq!(core.workspace_participant_count().expect("count"), 1);
        assert!(authority_weak
            .upgrade()
            .is_some_and(|authority| Arc::strong_count(&authority) == 2));

        let ticket = match core
            .begin_transition(crate::workspace_lifecycle::AdmissionKind::Open)
            .expect("Open admission")
        {
            crate::workspace_lifecycle::AdmissionOutcome::Admitted(ticket) => ticket,
            crate::workspace_lifecycle::AdmissionOutcome::NotAdmitted { .. } => {
                panic!("Open must wait for the retained participant")
            }
        };
        assert!(matches!(
            core.physical_exclusive_for_ticket(&ticket),
            Err(crate::workspace_lifecycle::LifecycleError::ActiveOperations)
        ));
        drop(participant);
        let exclusive = core
            .physical_exclusive_for_ticket(&ticket)
            .expect("retired participant permits protected transition");
        drop(exclusive);
    }
}
