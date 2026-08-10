//! Release Gate A: shadow migration supervisor contracts.
//!
//! These tests exercise on-disk workspaces. They intentionally call the public
//! supervisor API rather than `Database::migrate()` on the live path.

use grimodex_core::SCHEMA_VERSION;
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use grimodex_db::Database;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

#[cfg(feature = "test-failpoints")]
use grimodex_db::migration_supervisor::{Failpoint, MigrationSupervisorError};

fn temp_workspace(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "grimodex-mig-sup-{label}-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("create workspace");
    root
}

fn sha256_file(path: &Path) -> String {
    let mut file = fs::File::open(path).expect("open");
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = file.read(&mut buf).expect("read");
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    hex::encode(hasher.finalize())
}

fn seed_legacy_db(path: &Path, user_version: i32) {
    // Empty SQLite file stamped with an older/newer user_version. Avoid creating
    // partial legacy tables that conflict with migrate()'s additive ALTER path.
    let conn = rusqlite::Connection::open(path).expect("open seed");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.pragma_update(None, "user_version", user_version)
        .expect("stamp version");
}

fn live_user_version(ws: &Path) -> i32 {
    let db = Database::new(&ws.join("grimodex.db")).expect("open live");
    db.with_conn(|conn| {
        Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?)
    })
    .expect("read version")
}

#[test]
fn same_schema_opens_without_migration_snapshot() {
    let ws = temp_workspace("same");
    let db_path = ws.join("grimodex.db");
    // Create a fully migrated live DB first.
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate once");
    }
    let before = sha256_file(&db_path);
    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("open");
    match outcome {
        WorkspaceOpenDbOutcome::Ready {
            from_schema,
            to_schema,
            opened,
        } => {
            assert_eq!(from_schema, SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            // Shared lease must remain held for authority lifetime.
            let exclusive = grimodex_db::workspace_lease::acquire_exclusive(
                &ws,
                std::time::Duration::from_millis(50),
            );
            assert!(
                exclusive.is_err(),
                "shared lease on Ready must block exclusive"
            );
            drop(opened);
        }
        other => panic!("expected Ready, got {other:?}"),
    }
    assert_eq!(sha256_file(&db_path), before);
    let snaps = ws.join("backups/migrations");
    assert!(
        !snaps.exists() || fs::read_dir(&snaps).unwrap().next().is_none(),
        "same-schema open must not create migration snapshots"
    );
}

#[test]
fn legacy_schema_shadow_migrates_and_keeps_snapshot() {
    let ws = temp_workspace("legacy");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("migrate");
    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            receipt_path,
            opened,
        } => {
            assert_eq!(from_schema, 0);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists());
            assert!(
                receipt_path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .starts_with("receipt-"),
                "receipt_path must point at the receipt file, got {receipt_path:?}"
            );
            drop(opened);
        }
        other => panic!("expected Migrated, got {other:?}"),
    }
    assert_eq!(live_user_version(&ws), SCHEMA_VERSION);
    assert_ne!(sha256_file(&db_path), before, "live DB must be replaced");

    let snaps = fs::read_dir(ws.join("backups/migrations"))
        .expect("migrations dir")
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                == Some("db")
        })
        .count();
    assert!(snaps >= 1, "migration snapshot must remain");
}

#[test]
fn newer_schema_enters_safe_mode_without_touching_live() {
    let ws = temp_workspace("newer");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, SCHEMA_VERSION + 7);
    let before = sha256_file(&db_path);

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("inspect");
    match outcome {
        WorkspaceOpenDbOutcome::SafeMode { reason, .. } => {
            assert!(
                reason.contains("newer") || reason.contains("WORKSPACE_SAFE_MODE"),
                "reason={reason}"
            );
        }
        other => panic!("expected SafeMode, got {other:?}"),
    }
    assert_eq!(sha256_file(&db_path), before);
    assert_eq!(live_user_version(&ws), SCHEMA_VERSION + 7);
}

#[test]
fn current_marker_missing_invariants_uses_shadow_path() {
    let ws = temp_workspace("missing-inv");
    let db_path = ws.join("grimodex.db");
    // Current user_version but empty physical schema → must not take Ready /
    // live migrate(); must shadow-migrate instead.
    seed_legacy_db(&db_path, SCHEMA_VERSION);

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("migrate");
    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            ..
        } => {
            assert_eq!(from_schema, SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            drop(opened);
        }
        other => panic!("expected Migrated via shadow path, got {other:?}"),
    }
    assert_eq!(live_user_version(&ws), SCHEMA_VERSION);
}


#[test]
fn prepare_database_refuses_safe_mode_authority() {
    let newer_ws = temp_workspace("prep-newer");
    seed_legacy_db(&newer_ws.join("grimodex.db"), SCHEMA_VERSION + 3);
    let err = migration_supervisor::prepare_database_for_open(&newer_ws).expect_err("safe mode");
    assert!(
        err.to_string().contains("WORKSPACE_SAFE_MODE"),
        "err={err}"
    );
}


#[cfg(feature = "test-failpoints")]
mod failpoint_tests {
    use super::*;

#[test]
fn failpoint_after_snapshot_leaves_live_unchanged() {
    let ws = temp_workspace("fp-snapshot");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let err = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::AfterSnapshot),
    )
    .expect_err("failpoint must abort");
    assert!(
        matches!(err, MigrationSupervisorError::Failpoint(Failpoint::AfterSnapshot))
            || err.to_string().contains("migration.after_snapshot"),
        "err={err}"
    );
    assert_eq!(sha256_file(&db_path), before);
    assert_eq!(live_user_version(&ws), 0);
}

#[test]
fn failpoint_after_migrate_leaves_live_unchanged() {
    let ws = temp_workspace("fp-migrate");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let err = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::AfterMigrate),
    )
    .expect_err("failpoint must abort");
    assert!(
        err.to_string().contains("migration.after_migrate")
            || matches!(err, MigrationSupervisorError::Failpoint(Failpoint::AfterMigrate)),
        "err={err}"
    );
    assert_eq!(sha256_file(&db_path), before);
    assert_eq!(live_user_version(&ws), 0);
}

#[test]
fn failpoint_after_replace_rolls_back_to_recovery_required() {
    let ws = temp_workspace("fp-replace");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::AfterReplace),
    )
    .expect("recovery outcome");
    match outcome {
        WorkspaceOpenDbOutcome::RecoveryRequired {
            error_code,
            snapshot_path,
            ..
        } => {
            assert_eq!(error_code, "MIGRATION_AFTER_REPLACE_FAILED");
            assert!(snapshot_path.exists(), "snapshot must be preserved");
        }
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }
    assert_eq!(live_user_version(&ws), 0);
    // Rollback restores the verified VACUUM INTO snapshot (logically equivalent,
    // not necessarily byte-identical to the pre-migration main file).
    assert!(
        snapshot_still_present(&ws),
        "migration snapshot must survive post-replace rollback"
    );
}

fn snapshot_still_present(ws: &Path) -> bool {
    let Ok(entries) = fs::read_dir(ws.join("backups/migrations")) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.path()
            .extension()
            .and_then(|x| x.to_str())
            == Some("db")
    })
}

#[test]
fn failpoint_before_reopen_rolls_back_to_recovery_required() {
    let ws = temp_workspace("fp-before-reopen");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::BeforeReopen),
    )
    .expect("recovery outcome");
    match outcome {
        WorkspaceOpenDbOutcome::RecoveryRequired {
            error_code,
            snapshot_path,
            ..
        } => {
            assert_eq!(error_code, "MIGRATION_BEFORE_REOPEN_FAILED");
            assert!(snapshot_path.exists(), "snapshot must be preserved");
        }
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }
    assert_eq!(live_user_version(&ws), 0);
    assert!(snapshot_still_present(&ws));
}

#[test]
fn failpoint_reopen_failure_restores_without_publishing_database() {
    let ws = temp_workspace("fp-reopen");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::ReopenFailure),
    )
    .expect("recovery outcome");
    match outcome {
        WorkspaceOpenDbOutcome::RecoveryRequired {
            error_code,
            snapshot_path,
            available_backups,
            ..
        } => {
            assert_eq!(error_code, "MIGRATION_REOPEN_FAILED");
            assert!(snapshot_path.exists());
            assert!(
                available_backups
                    .iter()
                    .any(|b| b.format == "migration-db"),
                "migration snapshots must be recovery candidates: {available_backups:?}"
            );
        }
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }
    assert_eq!(live_user_version(&ws), 0);
    assert!(snapshot_still_present(&ws));
}

}

#[test]
fn exclusive_lease_contention_does_not_touch_live() {
    let ws = temp_workspace("lease");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let _holder = grimodex_db::workspace_lease::acquire_exclusive(
        &ws,
        std::time::Duration::from_millis(50),
    )
    .expect("hold exclusive");

    let err = migration_supervisor::open_or_migrate_workspace_db(&ws).expect_err("busy");
    let msg = err.to_string();
    assert!(
        msg.contains("WORKSPACE_MIGRATION_BUSY")
            || msg.contains("WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT"),
        "msg={msg}"
    );
    assert_eq!(sha256_file(&db_path), before);
}

#[test]
fn shared_lease_blocks_exclusive_migration() {
    let ws = temp_workspace("shared-blocks");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let _shared = grimodex_db::workspace_lease::try_acquire_shared(&ws).expect("shared");
    // Another shared can be acquired (shared locks are multi-reader), but exclusive
    // migration must time out while any shared holder exists.
    // open_or_migrate acquires shared first for inspect, then drops and takes exclusive.
    // With our held shared, exclusive times out.
    let err = migration_supervisor::open_or_migrate_workspace_db(&ws).expect_err("busy");
    let msg = err.to_string();
    assert!(
        msg.contains("WORKSPACE_MIGRATION_BUSY")
            || msg.contains("WORKSPACE_EXCLUSIVE_LEASE_TIMEOUT"),
        "msg={msg}"
    );
    assert_eq!(sha256_file(&db_path), before);
    assert_eq!(live_user_version(&ws), 0);
}
