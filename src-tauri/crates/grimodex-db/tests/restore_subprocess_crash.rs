//! Gate A2: Safe Mode restore subprocess crash after live seal.
//!
//! After WAL-preserving safety + live seal, a kill before atomic replace must
//! never silently Ready a DB that lost WAL-only commits. Outcomes allowed:
//! SafeMode (incomplete restore marker), Ready/Migrated with WAL commits intact,
//! or RecoveryRequired — never Ready that dropped WAL-only rows.
//!
//! Also covers the Recovery Shell journey: crash → SafeMode → restore candidate
//! → Retry Open → Ready with marker cleared.

#![cfg(feature = "test-failpoints")]

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use grimodex_db::backup_restore::read_incomplete_restore_session;
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use grimodex_db::open::{open_workspace_sync, OpenDeps};
use grimodex_db::recovery::{
    list_safe_mode_candidates, restore_safe_mode_candidate, WorkspaceOpenOutcome,
};
use grimodex_db::state::{with_db_state, GlobalSettingsPath, WorkspaceState};
use grimodex_db::Database;
use rusqlite::config::DbConfig;
use rusqlite::params;

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(25);
const WAL_KEY: &str = "gate-a2.wal-only";

#[test]
fn subprocess_kill_after_live_seal_does_not_drop_wal_commits_silently() {
    let workspace = temp_ws("restore-after-live-seal");
    let live = workspace.join("grimodex.db");
    create_migrated_db(&live, "live");
    commit_wal_only(&live);
    assert!(
        live.with_extension("db-wal").exists()
            || PathBuf::from(format!("{}-wal", live.display())).exists()
    );

    let candidate = workspace.join("backups/grimodex-auto.db");
    fs::create_dir_all(candidate.parent().expect("parent")).expect("mkdir");
    create_migrated_db(&candidate, "backup");

    let ready_path = workspace.join("restore-after-live-seal-ready");
    let mut child = spawn_restore_harness(
        &workspace,
        &candidate,
        "restore.after_live_seal",
        &ready_path,
    );
    let guard = ReapOnDrop(&mut child);
    wait_for_ready(
        guard.0,
        &ready_path,
        "restore.after_live_seal",
        READY_TIMEOUT,
    );
    guard.0.kill().expect("kill restore harness");
    let status = wait_for_exit(guard.0).expect("wait killed");
    assert!(!status.success());

    // Sealed live must still expose the WAL-only commit (now in main).
    assert_eq!(wal_only_value(&live), "committed only in wal");

    let marker = read_incomplete_restore_session(&workspace)
        .expect("read marker")
        .expect("restore session marker must remain after kill");
    assert_eq!(marker.phase, "epoch-minted");
    assert_eq!(marker.safety_kind, "logical");

    let reopen = migration_supervisor::open_or_migrate_workspace_db(&workspace)
        .expect("reopen after restore crash");
    match reopen {
        WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
            assert!(
                reason.contains("RESTORE_SESSION_INCOMPLETE"),
                "reason={reason}"
            );
        }
        WorkspaceOpenDbOutcome::RecoveryRequired { .. } => {}
        WorkspaceOpenDbOutcome::Ready { opened, .. }
        | WorkspaceOpenDbOutcome::Migrated { opened, .. } => {
            panic!(
                "incomplete restore marker must block Ready/Migrated authority; opened={opened:?}"
            );
        }
    }

    // Explicit clear + reopen may Ready with WAL commits preserved.
    grimodex_db::backup_restore::clear_restore_session_marker(&workspace).expect("clear");
    let after_clear =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("reopen after clear");
    match after_clear {
        WorkspaceOpenDbOutcome::Ready { opened, .. }
        | WorkspaceOpenDbOutcome::Migrated { opened, .. } => {
            drop(opened);
            assert_eq!(wal_only_value(&live), "committed only in wal");
        }
        other => panic!("expected Ready/Migrated after clearing marker, got {other:?}"),
    }

    let _ = fs::remove_dir_all(&workspace);
}

#[test]
fn subprocess_kill_after_live_seal_then_restore_candidate_reaches_ready() {
    for phase in ["restore.after_live_seal", "restore.after_replace"] {
        interrupted_install_then_explicit_recovery_reaches_ready(phase);
    }
}

fn interrupted_install_then_explicit_recovery_reaches_ready(phase: &str) {
    let root = temp_ws(phase);
    let workspace = root.join("workspace");
    fs::create_dir_all(workspace.join("backups")).expect("mkdir");
    let live = workspace.join("grimodex.db");
    create_migrated_db(&live, "live");
    commit_wal_only(&live);

    let candidate = workspace.join("backups/grimodex-auto.db");
    create_migrated_db(&candidate, "backup");

    let ready_path = root.join("restore-journey-ready");
    let mut child = spawn_restore_harness(&workspace, &candidate, phase, &ready_path);
    let guard = ReapOnDrop(&mut child);
    wait_for_ready(guard.0, &ready_path, phase, READY_TIMEOUT);
    let stopped_at = Instant::now();
    guard.0.kill().expect("kill");
    let status = wait_for_exit(guard.0).expect("observe actual Restore worker exit");
    assert!(!status.success());
    eprintln!(
        "BC-2 {phase} kill-to-exit: {:.3} ms (crash recovery, not cooperative cancellation)",
        stopped_at.elapsed().as_secs_f64() * 1000.0
    );

    let ws_state = WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: grimodex_db::WorkspaceLifecycleCompatibilityView::new(false),
        open_lock: Mutex::new(Default::default()),
    };
    let gs_path = GlobalSettingsPath {
        path: root.join("global-settings.json"),
        write_lock: Mutex::new(()),
    };
    let mut on_swapped = 0u32;
    let mut hook = || on_swapped += 1;
    let mut deps = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook,
    };

    let shell = open_workspace_sync(&ws_state, &mut deps, &workspace.to_string_lossy())
        .expect("open after crash");
    let WorkspaceOpenOutcome::SafeMode { reason, .. } = shell else {
        panic!("expected SafeMode after crash marker, got {shell:?}");
    };
    assert!(
        reason.contains("RESTORE_SESSION_INCOMPLETE"),
        "reason={reason}"
    );
    assert!(ws_state.safe_mode.is_active());
    assert!(
        with_db_state(&ws_state, |_| Ok(())).is_err(),
        "Safe Mode must not publish authority"
    );
    assert_eq!(on_swapped, 0);

    let candidates = list_safe_mode_candidates(&ws_state).expect("list candidates");
    let candidate_id = ws_state
        .safe_mode
        .with_session(|session| {
            session
                .candidates()
                .into_iter()
                .find(|candidate| {
                    session
                        .resolve(&candidate.id)
                        .map(|record| record.relative_key.ends_with("grimodex-auto.db"))
                        .unwrap_or(false)
                })
                .map(|candidate| candidate.id)
                .ok_or_else(|| {
                    grimodex_db::error::AppError::Anyhow(anyhow::anyhow!(
                        "grimodex-auto.db candidate missing; listed={candidates:?}"
                    ))
                })
        })
        .expect("automatic backup candidate id");

    restore_safe_mode_candidate(&ws_state, &candidate_id).expect("restore candidate");
    assert!(
        read_incomplete_restore_session(&workspace)
            .expect("marker read")
            .is_none(),
        "successful candidate restore must clear the restore session marker"
    );

    let mut hook2 = || on_swapped += 1;
    let mut deps2 = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook2,
    };
    let ready = open_workspace_sync(&ws_state, &mut deps2, &workspace.to_string_lossy())
        .expect("retry open");
    assert!(
        matches!(
            ready,
            WorkspaceOpenOutcome::Ready { .. } | WorkspaceOpenOutcome::Migrated { .. }
        ),
        "got {ready:?}"
    );
    assert!(ready.is_authority_published());
    assert!(!ws_state.safe_mode.is_active());
    assert_eq!(recovery_marker(&live), "backup");
    assert!(read_incomplete_restore_session(&workspace)
        .expect("marker read")
        .is_none());

    let _ = fs::remove_dir_all(&root);
}

/// A concurrent shared authority that starts writing immediately after the
/// restore's exclusive→shared handoff must never lose its WAL to the restore
/// publish: every candidate write (Epoch mint, FTS, seal, digest) belongs
/// inside the exclusive boundary, and nothing after the handoff may seal,
/// checkpoint, or delete sidecars on the live image.
#[test]
fn concurrent_shared_writer_after_handoff_survives_restore_publish() {
    let (root, ws_state) = handoff_workspace("restore-handoff-writer");
    let workspace = root.join("workspace");
    let live = workspace.join("grimodex.db");
    let backup_name = "grimodex-20200101-000000.db";
    let handoff_ready = root.join("handoff-ready");
    let handoff_continue = root.join("handoff-continue");
    let writer_ready = root.join("writer-ready");
    let writer_exit = root.join("writer-exit");
    let restore_result = thread::scope(|scope| {
        let mut restore = Some(scope.spawn(|| {
            grimodex_db::backup_restore::with_restore_handoff_for_test(
                &handoff_ready,
                &handoff_continue,
                || grimodex_db::backup_restore::restore_backup_core(&ws_state, backup_name, || {}),
            )
        }));
        let mut restore_guard = JoinRestoreOnDrop {
            thread: &mut restore,
            continue_path: &handoff_continue,
        };
        wait_for_handoff(&restore_guard, &handoff_ready, READY_TIMEOUT);

        let mut writer = spawn_wal_writer(&workspace, &writer_ready, &writer_exit);
        let guard = ReapOnDrop(&mut writer);
        wait_for_ready(guard.0, &writer_ready, "writer-ready", READY_TIMEOUT);

        fs::write(&handoff_continue, b"go").expect("signal restore continue");
        let restore_result = restore_guard.join().expect("restore thread");

        fs::write(&writer_exit, b"done").expect("signal writer exit");
        let status = wait_for_exit(guard.0).expect("wait wal writer");
        assert!(status.success(), "wal writer failed: {status}");
        restore_result
    });
    restore_result.expect("restore with a concurrent shared writer must succeed");

    // The writer's WAL-only commit is durable and visible; the restore result
    // and its session marker are intact.
    assert_eq!(wal_only_value(&live), "committed only in wal");
    assert_eq!(recovery_marker(&live), "backup");
    assert!(read_incomplete_restore_session(&workspace)
        .expect("marker read")
        .is_none());
    let _ = fs::remove_dir_all(&root);
}

fn handoff_workspace(label: &str) -> (PathBuf, WorkspaceState) {
    let root = temp_ws(label);
    let workspace = root.join("workspace");
    fs::create_dir_all(workspace.join("backups")).expect("mkdir");
    let live = workspace.join("grimodex.db");
    create_migrated_db(&live, "live");
    let backup_name = "grimodex-20200101-000000.db";
    create_migrated_db(&workspace.join("backups").join(backup_name), "backup");

    let ws_state = WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: grimodex_db::WorkspaceLifecycleCompatibilityView::new(false),
        open_lock: Mutex::new(Default::default()),
    };
    let gs_path = GlobalSettingsPath {
        path: root.join("global-settings.json"),
        write_lock: Mutex::new(()),
    };
    let mut on_swapped = 0u32;
    let mut hook = || on_swapped += 1;
    let mut deps = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook,
    };
    let opened = open_workspace_sync(&ws_state, &mut deps, &workspace.to_string_lossy())
        .expect("open workspace");
    assert!(opened.is_authority_published(), "got {opened:?}");

    (root, ws_state)
}

// Keep actual join ownership even when readiness or writer work panics. Scoped
// thread Drop alone can wait forever, and neither a signal nor is_finished is
// join evidence. Unknown completion aborts before the scope can implicitly join.
struct JoinRestoreOnDrop<'handle, 'scope> {
    thread:
        &'handle mut Option<thread::ScopedJoinHandle<'scope, grimodex_db::error::AppResult<()>>>,
    continue_path: &'handle Path,
}

impl JoinRestoreOnDrop<'_, '_> {
    fn join(&mut self) -> thread::Result<grimodex_db::error::AppResult<()>> {
        // is_finished alone does not cover thread-local teardown. Bound the
        // actual join with an owned watcher, and join that watcher as well.
        let started = Instant::now();
        thread::scope(|scope| {
            let (joined, completion) = std::sync::mpsc::sync_channel::<Instant>(1);
            let watcher = thread::Builder::new()
                .spawn_scoped(scope, move || {
                    let remaining = READY_TIMEOUT.saturating_sub(started.elapsed());
                    match completion.recv_timeout(remaining) {
                        Ok(finished) if finished.duration_since(started) <= READY_TIMEOUT => {}
                        _ => abort_unknown_restore_join(),
                    }
                })
                .unwrap_or_else(|_| abort_unknown_restore_join());
            let result = self.thread.take().expect("restore handle").join();
            joined
                .send(Instant::now())
                .unwrap_or_else(|_| abort_unknown_restore_join());
            watcher
                .join()
                .unwrap_or_else(|_| abort_unknown_restore_join());
            result
        })
    }
}

impl Drop for JoinRestoreOnDrop<'_, '_> {
    fn drop(&mut self) {
        if self.thread.is_some() {
            let _ = fs::write(self.continue_path, b"go");
            // Preserve the original panic if the restore thread also panicked.
            let _ = self.join();
        }
    }
}

fn abort_unknown_restore_join() -> ! {
    let _ = writeln!(std::io::stderr().lock(), "restore thread join UNKNOWN");
    // The outer job retains this workspace; abort is not retirement.
    std::process::abort();
}

fn wait_for_handoff(restore: &JoinRestoreOnDrop<'_, '_>, ready_path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if fs::read_to_string(ready_path).is_ok_and(|value| value.trim() == "after-shared-handoff")
        {
            return;
        }
        assert!(
            !restore
                .thread
                .as_ref()
                .expect("restore handle")
                .is_finished(),
            "restore exited before the shared handoff rendezvous"
        );
        assert!(
            Instant::now() < deadline,
            "timed out waiting for shared handoff rendezvous"
        );
        thread::sleep(POLL_INTERVAL);
    }
}

#[test]
fn handoff_timeout_and_writer_panic_join_the_restore_thread() {
    for readiness_timeout in [true, false] {
        let (root, ws_state) = handoff_workspace("handoff-unwind");
        let workspace = root.join("workspace");
        let ready_path = root.join("handoff-ready");
        let continue_path = root.join("handoff-continue");
        let mut writer = None;
        thread::scope(|scope| {
            let mut restore = Some(scope.spawn(|| {
                grimodex_db::backup_restore::with_restore_handoff_for_test(
                    &ready_path,
                    &continue_path,
                    || {
                        grimodex_db::backup_restore::restore_backup_core(
                            &ws_state,
                            "grimodex-20200101-000000.db",
                            || {},
                        )
                    },
                )
            }));
            let mut ready_observed = false;
            let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let guard = JoinRestoreOnDrop {
                    thread: &mut restore,
                    continue_path: &continue_path,
                };
                wait_for_handoff(&guard, &ready_path, READY_TIMEOUT);
                ready_observed = true;
                if readiness_timeout {
                    wait_for_handoff(&guard, &root.join("missing-ready"), Duration::ZERO);
                }
                let writer_ready = root.join("writer-ready");
                writer = Some(spawn_wal_writer(
                    &workspace,
                    &writer_ready,
                    &root.join("writer-exit"),
                ));
                let writer_guard = ReapOnDrop(writer.as_mut().expect("writer"));
                wait_for_ready(writer_guard.0, &writer_ready, "writer-ready", READY_TIMEOUT);
                assert_eq!(
                    wal_only_value(&workspace.join("grimodex.db")),
                    "committed only in wal"
                );
                panic!("injected assertion after handoff writer readiness");
            }));
            assert!(ready_observed, "regression must reach the real handoff");
            let failure = failure.expect_err("failure path must be exercised");
            assert_eq!(
                failure.downcast_ref::<&str>().copied(),
                Some(if readiness_timeout {
                    "timed out waiting for shared handoff rendezvous"
                } else {
                    "injected assertion after handoff writer readiness"
                })
            );
            assert!(
                restore.is_none(),
                "guard must actually join before returning"
            );
        });
        if let Some(mut writer) = writer {
            let status = writer
                .try_wait()
                .expect("poll writer")
                .expect("actual writer exit");
            assert!(!status.success(), "writer must have been terminated");
        }
        fs::remove_dir_all(&root).expect("remove fixture after actual joins/exit");
    }
}

#[test]
fn handoff_hook_is_thread_local_rejects_nesting_and_clears_after_panic() {
    use grimodex_db::backup_restore::{restore_backup_core, with_restore_handoff_for_test};

    let (root, ws_state) = handoff_workspace("handoff-hook");
    let (other_root, other_state) = handoff_workspace("handoff-unrelated");
    let ready_path = root.join("handoff-ready");
    let continue_path = root.join("handoff-continue");
    let backup_name = "grimodex-20200101-000000.db";
    with_restore_handoff_for_test(&ready_path, &continue_path, || {
        let nested = std::panic::catch_unwind(|| {
            with_restore_handoff_for_test(
                &root.join("wrong-ready"),
                &root.join("wrong-continue"),
                || {
                    panic!("nested operation must not start");
                },
            );
        });
        assert_eq!(
            nested
                .expect_err("nesting must reject")
                .downcast_ref::<&str>()
                .copied(),
            Some("restore handoff already bound")
        );
        // This actual concurrent restore must not use the caller's rendezvous.
        thread::scope(|scope| {
            let mut restore =
                Some(scope.spawn(|| restore_backup_core(&other_state, backup_name, || {})));
            let mut guard = JoinRestoreOnDrop {
                thread: &mut restore,
                continue_path: &continue_path,
            };
            guard
                .join()
                .expect("unrelated restore thread")
                .expect("unrelated restore");
        });
        assert!(
            !ready_path.exists(),
            "unrelated thread must not inherit the hook"
        );
        fs::write(&continue_path, b"go").expect("signal own restore");
        restore_backup_core(&ws_state, backup_name, || {})
            .expect("own restore after nested rejection");
        assert_eq!(
            fs::read_to_string(&ready_path).expect("own ready"),
            "after-shared-handoff\n"
        );
    });
    fs::remove_file(&ready_path).expect("remove old ready");
    fs::remove_file(&continue_path).expect("remove old continue");
    let failure = std::panic::catch_unwind(|| {
        with_restore_handoff_for_test(&ready_path, &continue_path, || {
            panic!("injected hook panic");
        });
    });
    assert_eq!(
        failure
            .expect_err("hook panic")
            .downcast_ref::<&str>()
            .copied(),
        Some("injected hook panic")
    );
    restore_backup_core(&ws_state, backup_name, || {}).expect("restore after hook unwind");
    assert!(!ready_path.exists(), "unwound hook must not run again");
    fs::remove_dir_all(&root).expect("remove own fixture");
    fs::remove_dir_all(&other_root).expect("remove unrelated fixture after actual join");
}

fn temp_ws(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "grimodex-restore-crash-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(path.join("backups")).expect("mkdir");
    path
}

fn create_migrated_db(path: &Path, marker: &str) {
    let db = Database::new(path).expect("db");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('recovery-test', ?)",
        &[serde_json::Value::String(marker.to_string())],
        "run",
    )
    .expect("marker");
}

fn recovery_marker(db_path: &Path) -> String {
    let db = Database::new(db_path).expect("db");
    let rows = db
        .execute(
            "SELECT value FROM app_settings WHERE key = 'recovery-test'",
            &[],
            "get",
        )
        .expect("read");
    rows[0]["value"].as_str().unwrap_or_default().to_string()
}

fn commit_wal_only(db_path: &Path) {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .expect("no ckpt");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.pragma_update(None, "wal_autocheckpoint", 0)
        .expect("autocheckpoint");
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![WAL_KEY, "committed only in wal"],
    )
    .expect("wal commit");
}

fn wal_only_value(db_path: &Path) -> String {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    let _ = conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true);
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        [WAL_KEY],
        |row| row.get(0),
    )
    .expect("wal-only row")
}

fn spawn_restore_harness(
    workspace: &Path,
    candidate: &Path,
    failpoint: &str,
    ready_path: &Path,
) -> Child {
    Command::new(restore_harness_exe())
        .arg("--workspace")
        .arg(workspace)
        .arg("--candidate")
        .arg(candidate)
        .arg("--failpoint")
        .arg(failpoint)
        .env("GRIMODEX_RESTORE_FAILPOINT_READY_PATH", ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn restore crash harness")
}

fn spawn_wal_writer(workspace: &Path, ready_path: &Path, exit_path: &Path) -> Child {
    Command::new(restore_harness_exe())
        .arg("--workspace")
        .arg(workspace)
        .arg("--wal-writer-ready")
        .arg(ready_path)
        .arg("--wal-writer-exit")
        .arg(exit_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn wal writer")
}

fn restore_harness_exe() -> PathBuf {
    let Some(path) = option_env!("CARGO_BIN_EXE_restore-crash-harness") else {
        panic!("restore-crash-harness binary should be registered for test-failpoints");
    };
    PathBuf::from(path)
}

// Child's Drop does not terminate or reap it. Keep this borrow across readiness,
// handoff writes, restore-thread joins and assertions, including unwinding.
struct ReapOnDrop<'a>(&'a mut Child);

impl Drop for ReapOnDrop<'_> {
    fn drop(&mut self) {
        if let Ok(Some(_)) = self.0.try_wait() {
            return;
        }
        let _ = self.0.kill();
        if let Err(error) = wait_for_exit(self.0) {
            // Bypass libtest capture, which abort would discard.
            let _ = writeln!(
                std::io::stderr().lock(),
                "restore child {} exit UNKNOWN: {error}",
                self.0.id()
            );
            // The outer job retains this PID/workspace until actual cleanup.
            std::process::abort();
        }
    }
}

fn wait_for_exit(child: &mut Child) -> std::io::Result<ExitStatus> {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "restore child exit was not observed",
            ));
        }
        thread::sleep(POLL_INTERVAL);
    }
}

#[test]
fn restore_readiness_timeout_and_assertion_panic_reap_the_parked_child() {
    for readiness_timeout in [true, false] {
        let workspace = temp_ws("restore-child-unwind");
        create_migrated_db(&workspace.join("grimodex.db"), "live");
        let candidate = workspace.join("backups/grimodex-auto.db");
        create_migrated_db(&candidate, "backup");
        let ready_path = workspace.join("child-ready");
        let mut child = spawn_restore_harness(
            &workspace,
            &candidate,
            "restore.after_live_seal",
            &ready_path,
        );
        let mut ready_observed = false;
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard = ReapOnDrop(&mut child);
            wait_for_ready(
                guard.0,
                &ready_path,
                "restore.after_live_seal",
                READY_TIMEOUT,
            );
            ready_observed = true;
            if readiness_timeout {
                wait_for_ready(
                    guard.0,
                    &workspace.join("missing-ready"),
                    "restore.after_live_seal",
                    Duration::ZERO,
                );
            }
            panic!("injected assertion after restore readiness");
        }));
        assert!(
            ready_observed,
            "regression must reach the real parked child"
        );
        let failure = failure.expect_err("failure path must be exercised");
        if readiness_timeout {
            assert_eq!(
                failure.downcast_ref::<String>().map(String::as_str),
                Some("timed out waiting for restore harness ready marker restore.after_live_seal")
            );
        } else {
            assert_eq!(
                failure.downcast_ref::<&str>().copied(),
                Some("injected assertion after restore readiness")
            );
        }
        let status = child
            .try_wait()
            .expect("poll child after unwind")
            .expect("guard must reap the actual restore child before returning");
        assert!(!status.success(), "parked child must have been terminated");
        fs::remove_dir_all(&workspace).expect("remove fixture after child exit");
    }
}

#[test]
fn writer_readiness_timeout_and_assertion_panic_reap_the_live_child() {
    for readiness_timeout in [true, false] {
        let workspace = temp_ws("writer-child-unwind");
        let live = workspace.join("grimodex.db");
        create_migrated_db(&live, "live");
        let ready_path = workspace.join("writer-ready");
        let exit_path = workspace.join("writer-exit");
        let mut writer = spawn_wal_writer(&workspace, &ready_path, &exit_path);
        let mut ready_observed = false;
        let failure = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard = ReapOnDrop(&mut writer);
            wait_for_ready(guard.0, &ready_path, "writer-ready", READY_TIMEOUT);
            assert_eq!(wal_only_value(&live), "committed only in wal");
            ready_observed = true;
            if readiness_timeout {
                wait_for_ready(
                    guard.0,
                    &workspace.join("missing-ready"),
                    "writer-ready",
                    Duration::ZERO,
                );
            }
            panic!("injected assertion after writer readiness");
        }));
        assert!(ready_observed, "regression must reach the real WAL writer");
        let failure = failure.expect_err("failure path must be exercised");
        if readiness_timeout {
            assert_eq!(
                failure.downcast_ref::<String>().map(String::as_str),
                Some("timed out waiting for restore harness ready marker writer-ready")
            );
        } else {
            assert_eq!(
                failure.downcast_ref::<&str>().copied(),
                Some("injected assertion after writer readiness")
            );
        }
        let status = writer
            .try_wait()
            .expect("poll writer after unwind")
            .expect("guard must reap the actual WAL writer before returning");
        assert!(!status.success(), "live writer must have been terminated");
        fs::remove_dir_all(&workspace).expect("remove fixture after writer exit");
    }
}

fn wait_for_ready(child: &mut Child, ready_path: &Path, expected: &str, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait().expect("poll restore harness") {
            panic!("restore harness exited before {expected}: {status}");
        }
        if let Ok(contents) = fs::read_to_string(ready_path) {
            if contents.trim() == expected {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for restore harness ready marker {expected}"
        );
        thread::sleep(POLL_INTERVAL);
    }
}
