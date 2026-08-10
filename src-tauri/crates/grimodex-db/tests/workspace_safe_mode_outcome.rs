//! Gate A2: structured Safe Mode open outcome + restore-only session.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use grimodex_core::SCHEMA_VERSION;
use grimodex_db::open::{open_workspace_sync, OpenDeps};
use grimodex_db::recovery::{
    list_safe_mode_candidates, restore_safe_mode_candidate, verify_safe_mode_candidate,
    RecoveryCandidateKind, WorkspaceOpenOutcome,
};
use grimodex_db::state::{with_db_state, GlobalSettingsPath, WorkspaceState};
use grimodex_db::Database;

fn temp_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("grimodex-a2-{label}-{nanos}"));
    fs::create_dir_all(&path).expect("mkdir");
    path
}

fn seed_newer_schema(db_path: &Path) {
    let conn = rusqlite::Connection::open(db_path).expect("open");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
        .expect("version");
}

fn workspace_state() -> WorkspaceState {
    WorkspaceState {
        inner: Mutex::new(None),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: std::sync::atomic::AtomicBool::new(false),
        open_lock: Mutex::new(()),
    }
}

#[test]
fn newer_schema_open_returns_structured_safe_mode_without_authority() {
    let root = temp_dir("newer-open");
    let ws = root.join("workspace");
    fs::create_dir_all(&ws).expect("ws");
    seed_newer_schema(&ws.join("grimodex.db"));

    let ws_state = workspace_state();
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

    let outcome = open_workspace_sync(&ws_state, &mut deps, &ws.to_string_lossy())
        .expect("safe mode is Ok outcome");
    match outcome {
        WorkspaceOpenOutcome::SafeMode { reason, candidates } => {
            assert!(
                reason.contains("WORKSPACE_SAFE_MODE") || reason.contains("newer"),
                "reason={reason}"
            );
            let _ = candidates;
        }
        other => panic!("expected SafeMode, got {other:?}"),
    }
    assert_eq!(
        on_swapped, 0,
        "Safe Mode must not run on_swapped hydration hooks"
    );
    assert!(ws_state.safe_mode.is_active());
    let err = with_db_state(&ws_state, |_db| Ok(())).expect_err("no authority");
    assert!(err.to_string().contains("WORKSPACE_SAFE_MODE"), "err={err}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn safe_mode_lists_opaque_candidate_ids_for_backups_and_snapshots() {
    let root = temp_dir("opaque-list");
    let ws = root.join("workspace");
    fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
    seed_newer_schema(&ws.join("grimodex.db"));

    let backup = ws.join("backups/grimodex-auto.db");
    {
        let db = Database::new(&backup).expect("backup");
        db.migrate().expect("migrate");
    }
    let snap = ws.join("backups/migrations/migration-demo.db");
    {
        let db = Database::new(&snap).expect("snap");
        db.migrate().expect("migrate snap");
    }

    let ws_state = workspace_state();
    let gs_path = GlobalSettingsPath {
        path: root.join("global-settings.json"),
        write_lock: Mutex::new(()),
    };
    let mut hook = || {};
    let mut deps = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook,
    };
    let shell = open_workspace_sync(&ws_state, &mut deps, &ws.to_string_lossy())
        .expect("structured safe mode");
    let WorkspaceOpenOutcome::SafeMode { candidates, .. } = shell else {
        panic!("expected SafeMode, got {shell:?}");
    };
    assert!(
        candidates.len() >= 2,
        "expected backup + migration snapshot: {candidates:?}"
    );
    for candidate in &candidates {
        assert!(candidate.id.starts_with("rc_"));
        assert!(!candidate.id.contains('/'));
        assert!(!candidate.id.contains(".db"));
    }

    let listed = list_safe_mode_candidates(&ws_state).expect("list");
    let automatic = listed
        .iter()
        .find(|c| c.kind == RecoveryCandidateKind::AutomaticBackup)
        .expect("automatic backup");
    let verified = verify_safe_mode_candidate(&ws_state, &automatic.id).expect("verify");
    assert_eq!(verified.id, automatic.id);

    let migration = listed
        .iter()
        .find(|c| c.kind == RecoveryCandidateKind::MigrationSnapshot)
        .expect("migration snapshot");
    assert_eq!(
        migration.checksum_status,
        grimodex_db::recovery::ChecksumStatus::Unverified
    );

    let _ = fs::remove_dir_all(&root);
}

#[cfg(feature = "test-failpoints")]
#[test]
fn recovery_required_session_exposes_opaque_snapshot_id() {
    use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
    use grimodex_db::recovery::session_from_db_outcome;

    let root = temp_dir("recovery-ids");
    let ws = root.join("workspace");
    fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
    let db_path = ws.join("grimodex.db");
    {
        let conn = rusqlite::Connection::open(&db_path).expect("open");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "user_version", 0)
            .expect("version");
    }

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(migration_supervisor::Failpoint::AfterReplace),
    )
    .expect("recovery");
    let WorkspaceOpenDbOutcome::RecoveryRequired {
        reason,
        error_code,
        snapshot_path,
        ..
    } = &outcome
    else {
        panic!("expected RecoveryRequired, got {outcome:?}");
    };

    let session = session_from_db_outcome(&ws, &outcome)
        .expect("session")
        .expect("restore-only session");
    assert_eq!(session.reason, *reason);
    assert_eq!(session.error_code.as_deref(), Some(error_code.as_str()));
    let snapshot_id = session.snapshot_id.clone().expect("snapshot id");
    assert!(session
        .candidates()
        .iter()
        .any(|c| c.id == snapshot_id && c.kind == RecoveryCandidateKind::MigrationSnapshot));
    assert!(snapshot_path.exists());

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn safe_mode_restore_by_opaque_id_then_reopen_ready() {
    let root = temp_dir("restore-id");
    let ws = root.join("workspace");
    fs::create_dir_all(ws.join("backups")).expect("dirs");

    // Live DB is newer-than-supported → Safe Mode.
    seed_newer_schema(&ws.join("grimodex.db"));

    // Automatic backup is a migratable current-schema image.
    let backup = ws.join("backups/grimodex-auto.db");
    {
        let db = Database::new(&backup).expect("backup");
        db.migrate().expect("migrate backup");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'Restored', 'ja')",
                ["project-restored"],
            )?;
            Ok(())
        })
        .expect("seed");
    }

    let ws_state = workspace_state();
    let gs_path = GlobalSettingsPath {
        path: root.join("global-settings.json"),
        write_lock: Mutex::new(()),
    };
    let mut hook = || {};
    let mut deps = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook,
    };
    let outcome =
        open_workspace_sync(&ws_state, &mut deps, &ws.to_string_lossy()).expect("safe mode");
    assert!(matches!(outcome, WorkspaceOpenOutcome::SafeMode { .. }));

    let candidates = list_safe_mode_candidates(&ws_state).expect("list");
    let backup_candidate = candidates
        .iter()
        .find(|c| c.kind == RecoveryCandidateKind::AutomaticBackup)
        .expect("automatic backup");
    restore_safe_mode_candidate(&ws_state, &backup_candidate.id).expect("restore");
    assert!(
        ws_state.safe_mode.is_active(),
        "Safe Mode session remains until Ready/Migrated reopen"
    );

    let mut hook2 = || {};
    let mut deps2 = OpenDeps {
        gs_path: &gs_path,
        on_swapped: &mut hook2,
    };
    let reopened = open_workspace_sync(&ws_state, &mut deps2, &ws.to_string_lossy())
        .expect("reopen after restore");
    assert!(
        matches!(
            reopened,
            WorkspaceOpenOutcome::Ready { .. } | WorkspaceOpenOutcome::Migrated { .. }
        ),
        "got {reopened:?}"
    );
    assert!(!ws_state.safe_mode.is_active());

    with_db_state(&ws_state, |db| {
        let count: i64 = db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE id = 'project-restored'",
                [],
                |row| row.get(0),
            )?)
        })?;
        assert_eq!(count, 1);
        Ok(())
    })
    .expect("authority published");

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn corrupt_live_db_open_returns_structured_safe_mode_without_authority() {
    let root = temp_dir("corrupt-open");
    let ws = root.join("workspace");
    fs::create_dir_all(&ws).expect("ws");
    fs::write(ws.join("grimodex.db"), b"not a sqlite database at all")
        .expect("write corrupt live db");

    let ws_state = workspace_state();
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

    let outcome = open_workspace_sync(&ws_state, &mut deps, &ws.to_string_lossy())
        .expect("corrupt live db must surface as Safe Mode outcome");
    match outcome {
        WorkspaceOpenOutcome::SafeMode { reason, .. } => {
            assert!(reason.contains("WORKSPACE_SAFE_MODE"), "reason={reason}");
        }
        other => panic!("expected SafeMode, got {other:?}"),
    }
    assert_eq!(on_swapped, 0);
    assert!(ws_state.safe_mode.is_active());
    let err = with_db_state(&ws_state, |_db| Ok(())).expect_err("no authority");
    assert!(err.to_string().contains("WORKSPACE_SAFE_MODE"), "err={err}");

    let _ = fs::remove_dir_all(&root);
}

#[cfg(feature = "test-failpoints")]
#[test]
fn after_snapshot_failpoint_open_workspace_enters_safe_mode_with_candidates() {
    use grimodex_db::migration_supervisor::{self, Failpoint, WorkspaceOpenDbOutcome};

    let root = temp_dir("after-snapshot-open");
    let ws = root.join("workspace");
    fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
    {
        let conn = rusqlite::Connection::open(ws.join("grimodex.db")).expect("open");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "user_version", 0)
            .expect("version");
    }

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::AfterSnapshot),
    )
    .expect("safe mode");
    let WorkspaceOpenDbOutcome::SafeMode {
        reason,
        available_backups,
    } = outcome
    else {
        panic!("expected SafeMode, got {outcome:?}");
    };
    assert!(reason.contains("WORKSPACE_SAFE_MODE"), "reason={reason}");
    assert!(
        available_backups.iter().any(|b| b.format == "migration-db"),
        "snapshot candidate required: {available_backups:?}"
    );

    // Wire the same outcome through open_workspace_sync's session path.
    let ws_state = workspace_state();
    let session = grimodex_db::recovery::session_from_db_outcome(
        &ws,
        &WorkspaceOpenDbOutcome::SafeMode {
            reason: reason.clone(),
            available_backups: available_backups.clone(),
        },
    )
    .expect("session")
    .expect("safe mode session");
    ws_state.safe_mode.enter(session).expect("enter");
    assert!(ws_state.safe_mode.is_active());
    let listed = list_safe_mode_candidates(&ws_state).expect("list");
    assert!(
        listed
            .iter()
            .any(|c| c.kind == RecoveryCandidateKind::MigrationSnapshot),
        "listed={listed:?}"
    );
    let err = with_db_state(&ws_state, |_db| Ok(())).expect_err("no authority");
    assert!(err.to_string().contains("WORKSPACE_SAFE_MODE"), "err={err}");

    let _ = fs::remove_dir_all(&root);
}

#[cfg(feature = "test-failpoints")]
#[test]
fn after_migrate_failpoint_open_keeps_snapshot_for_recovery_shell() {
    use grimodex_db::migration_supervisor::{self, Failpoint, WorkspaceOpenDbOutcome};

    let root = temp_dir("after-migrate-open");
    let ws = root.join("workspace");
    fs::create_dir_all(ws.join("backups/migrations")).expect("dirs");
    {
        let conn = rusqlite::Connection::open(ws.join("grimodex.db")).expect("open");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "user_version", 0)
            .expect("version");
    }
    let before = fs::read(ws.join("grimodex.db")).expect("read live");

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::AfterMigrate),
    )
    .expect("safe mode");
    match outcome {
        WorkspaceOpenDbOutcome::SafeMode {
            reason,
            available_backups,
        } => {
            assert!(reason.contains("snapshot="), "reason={reason}");
            assert!(
                available_backups.iter().any(|b| b.format == "migration-db"),
                "{available_backups:?}"
            );
        }
        other => panic!("expected SafeMode, got {other:?}"),
    }
    assert_eq!(
        fs::read(ws.join("grimodex.db")).expect("read after"),
        before,
        "live DB must remain unchanged before replace"
    );

    let _ = fs::remove_dir_all(&root);
}
