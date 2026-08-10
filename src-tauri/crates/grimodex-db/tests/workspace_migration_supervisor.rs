//! Release Gate A: shadow migration supervisor contracts.
//!
//! These tests exercise on-disk workspaces. They intentionally call the public
//! supervisor API rather than `Database::migrate()` on the live path.

use grimodex_core::SCHEMA_VERSION;
use grimodex_db::migration_supervisor::{
    self, Failpoint, MigrationSupervisorError, WorkspaceOpenDbOutcome,
};
use grimodex_db::Database;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

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
        WorkspaceOpenDbOutcome::Ready { from_schema, to_schema, .. } => {
            assert_eq!(from_schema, SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
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
            ..
        } => {
            assert_eq!(from_schema, 0);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists());
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
fn failpoint_reopen_failure_restores_rollback_sidecar() {
    let ws = temp_workspace("fp-reopen");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
        &ws,
        Some(Failpoint::ReopenFailure),
    )
    .expect("recovered open");
    match outcome {
        WorkspaceOpenDbOutcome::MigrationRecovered {
            error_code,
            snapshot_path,
            ..
        } => {
            assert_eq!(error_code, "MIGRATION_REOPEN_FAILED");
            assert!(snapshot_path.exists());
        }
        other => panic!("expected MigrationRecovered, got {other:?}"),
    }
    assert_eq!(sha256_file(&db_path), before);
    assert_eq!(live_user_version(&ws), 0);
}

#[test]
fn exclusive_lease_contention_does_not_touch_live() {
    let ws = temp_workspace("lease");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let _holder = grimodex_db::workspace_lease::acquire_exclusive(&ws, std::time::Duration::from_millis(50))
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
