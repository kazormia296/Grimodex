//! Gate A2 subprocess crash recovery tests.
//!
//! The child process parks at supervisor failpoints, then the parent kills that
//! specific child PID. This catches process-death behavior that in-process
//! failpoints cannot cover because Rust destructors do not run after SIGKILL.

#![cfg(feature = "test-failpoints")]

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use grimodex_core::{PREVIOUS_COMPATIBLE_SCHEMA_VERSION, SCHEMA_VERSION};
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};

use release_schema_fixture::{
    assert_release_fixture_rows, live_user_version, seed_previous_release_workspace, temp_workspace,
};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, Copy)]
struct CrashStage {
    label: &'static str,
    failpoint: &'static str,
    live_may_already_be_replaced: bool,
}

const CRASH_STAGES: &[CrashStage] = &[
    CrashStage {
        label: "after-snapshot",
        failpoint: "migration.after_snapshot",
        live_may_already_be_replaced: false,
    },
    CrashStage {
        label: "after-staged-migrate",
        failpoint: "migration.after_migrate",
        live_may_already_be_replaced: false,
    },
    CrashStage {
        label: "after-replace",
        failpoint: "migration.after_replace",
        live_may_already_be_replaced: true,
    },
    CrashStage {
        label: "before-reopen",
        failpoint: "migration.before_reopen",
        live_may_already_be_replaced: true,
    },
];

#[test]
fn subprocess_crash_at_migration_stages_recovers_on_next_open() {
    for stage in CRASH_STAGES {
        let workspace = temp_workspace(stage.label);
        let db_path = seed_previous_release_workspace(&workspace);
        let ready_path = workspace.join(format!("{}-ready", stage.label));

        let mut child = spawn_crash_harness(&workspace, stage.failpoint, &ready_path);
        wait_for_failpoint_ready(&mut child, &ready_path, stage.failpoint);
        child.kill().expect("kill crash harness process by PID");
        let status = child.wait().expect("wait for killed crash harness");
        assert!(
            !status.success(),
            "killed crash harness should not exit successfully"
        );

        let version_after_kill = live_user_version(&workspace);
        if stage.live_may_already_be_replaced {
            assert!(
                version_after_kill == PREVIOUS_COMPATIBLE_SCHEMA_VERSION
                    || version_after_kill == SCHEMA_VERSION,
                "live marker after {} crash should be old or replaced, got {version_after_kill}",
                stage.label
            );
        } else {
            assert_eq!(version_after_kill, PREVIOUS_COMPATIBLE_SCHEMA_VERSION);
        }

        let reopen = migration_supervisor::open_or_migrate_workspace_db(&workspace)
            .expect("parent reopen after child crash should not error");
        match reopen {
            WorkspaceOpenDbOutcome::Ready {
                from_schema,
                to_schema,
                opened,
            } => {
                assert_eq!(from_schema, SCHEMA_VERSION);
                assert_eq!(to_schema, SCHEMA_VERSION);
                drop(opened);
                assert_release_fixture_rows(&db_path);
            }
            WorkspaceOpenDbOutcome::Migrated {
                from_schema,
                to_schema,
                opened,
                ..
            } => {
                assert_eq!(from_schema, PREVIOUS_COMPATIBLE_SCHEMA_VERSION);
                assert_eq!(to_schema, SCHEMA_VERSION);
                drop(opened);
                assert_release_fixture_rows(&db_path);
            }
            WorkspaceOpenDbOutcome::RecoveryRequired {
                snapshot_path,
                available_backups,
                ..
            } => {
                assert!(
                    snapshot_path.exists(),
                    "snapshot should remain for recovery"
                );
                assert!(
                    available_backups
                        .iter()
                        .any(|backup| backup.format == "migration-db"),
                    "migration snapshot should be listed as a recovery candidate"
                );
            }
            WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
                panic!("unexpected SafeMode after {} crash: {reason}", stage.label);
            }
        }
    }
}

fn spawn_crash_harness(workspace: &Path, failpoint: &str, ready_path: &Path) -> Child {
    Command::new(crash_harness_exe())
        .arg("--workspace")
        .arg(workspace)
        .arg("--failpoint")
        .arg(failpoint)
        .env("GRIMODEX_MIGRATION_FAILPOINT_READY_PATH", ready_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .expect("spawn migration crash harness")
}

fn crash_harness_exe() -> PathBuf {
    let Some(path) = option_env!("CARGO_BIN_EXE_migration-crash-harness") else {
        panic!("migration-crash-harness binary should be registered for test-failpoints");
    };
    PathBuf::from(path)
}

fn wait_for_failpoint_ready(child: &mut Child, ready_path: &Path, expected: &str) {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        if let Some(status) = child.try_wait().expect("poll crash harness") {
            panic!("crash harness exited before failpoint {expected}: {status}");
        }
        if let Ok(contents) = fs::read_to_string(ready_path) {
            if contents.trim() == expected {
                return;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for crash harness failpoint {expected}"
        );
        thread::sleep(POLL_INTERVAL);
    }
}
