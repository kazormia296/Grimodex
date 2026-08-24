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
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
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
    wait_for_ready(&mut child, &ready_path, "restore.after_live_seal");
    child.kill().expect("kill restore harness");
    let status = child.wait().expect("wait killed");
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
    let root = temp_ws("restore-journey");
    let workspace = root.join("workspace");
    fs::create_dir_all(workspace.join("backups")).expect("mkdir");
    let live = workspace.join("grimodex.db");
    create_migrated_db(&live, "live");
    commit_wal_only(&live);

    let candidate = workspace.join("backups/grimodex-auto.db");
    create_migrated_db(&candidate, "backup");

    let ready_path = root.join("restore-journey-ready");
    let mut child = spawn_restore_harness(
        &workspace,
        &candidate,
        "restore.after_live_seal",
        &ready_path,
    );
    wait_for_ready(&mut child, &ready_path, "restore.after_live_seal");
    child.kill().expect("kill");
    let _ = child.wait();

    let ws_state = WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: std::sync::atomic::AtomicBool::new(false),
        open_lock: Mutex::new(()),
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
    let root = temp_ws("restore-handoff-writer");
    let workspace = root.join("workspace");
    fs::create_dir_all(workspace.join("backups")).expect("mkdir");
    let live = workspace.join("grimodex.db");
    create_migrated_db(&live, "live");
    let backup_name = "grimodex-20200101-000000.db";
    create_migrated_db(&workspace.join("backups").join(backup_name), "backup");

    let ws_state = WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: std::sync::atomic::AtomicBool::new(false),
        open_lock: Mutex::new(()),
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

    let handoff_ready = root.join("handoff-ready");
    let handoff_continue = root.join("handoff-continue");
    std::env::set_var("GRIMODEX_RESTORE_HANDOFF_READY_PATH", &handoff_ready);
    std::env::set_var("GRIMODEX_RESTORE_HANDOFF_CONTINUE_PATH", &handoff_continue);

    let writer_ready = root.join("writer-ready");
    let writer_exit = root.join("writer-exit");
    let restore_result = thread::scope(|scope| {
        let restore = scope.spawn(|| {
            grimodex_db::backup_restore::restore_backup_core(&ws_state, backup_name, || {})
        });

        let deadline = Instant::now() + READY_TIMEOUT;
        while !handoff_ready.exists() {
            assert!(
                Instant::now() < deadline,
                "restore never reached the shared handoff rendezvous"
            );
            thread::sleep(POLL_INTERVAL);
        }

        let mut writer = Command::new(restore_harness_exe())
            .arg("--workspace")
            .arg(&workspace)
            .arg("--wal-writer-ready")
            .arg(&writer_ready)
            .arg("--wal-writer-exit")
            .arg(&writer_exit)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn wal writer");
        let deadline = Instant::now() + READY_TIMEOUT;
        while !writer_ready.exists() {
            if let Ok(Some(status)) = writer.try_wait() {
                panic!("wal writer exited early: {status}");
            }
            assert!(
                Instant::now() < deadline,
                "wal writer never became ready after the handoff"
            );
            thread::sleep(POLL_INTERVAL);
        }

        fs::write(&handoff_continue, b"go").expect("signal restore continue");
        let restore_result = restore.join().expect("restore thread");

        fs::write(&writer_exit, b"done").expect("signal writer exit");
        let status = writer.wait().expect("wait wal writer");
        assert!(status.success(), "wal writer failed: {status}");
        restore_result
    });
    std::env::remove_var("GRIMODEX_RESTORE_HANDOFF_READY_PATH");
    std::env::remove_var("GRIMODEX_RESTORE_HANDOFF_CONTINUE_PATH");
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

fn restore_harness_exe() -> PathBuf {
    let Some(path) = option_env!("CARGO_BIN_EXE_restore-crash-harness") else {
        panic!("restore-crash-harness binary should be registered for test-failpoints");
    };
    PathBuf::from(path)
}

fn wait_for_ready(child: &mut Child, ready_path: &Path, expected: &str) {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            panic!("restore harness exited early: {status}");
        }
        if let Ok(contents) = fs::read_to_string(ready_path) {
            if contents.trim() == expected {
                return;
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    let _ = child.kill();
    panic!("timed out waiting for restore failpoint ready marker");
}
