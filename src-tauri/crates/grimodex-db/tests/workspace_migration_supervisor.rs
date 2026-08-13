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
use grimodex_db::migration_supervisor::Failpoint;

fn temp_workspace(label: &str) -> PathBuf {
    let root =
        std::env::temp_dir().join(format!("grimodex-mig-sup-{label}-{}", uuid::Uuid::new_v4()));
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
    db.with_conn(|conn| Ok(conn.pragma_query_value(None, "user_version", |row| row.get(0))?))
        .expect("read version")
}

fn live_table_exists(ws: &Path, table: &str) -> bool {
    let db = Database::new(&ws.join("grimodex.db")).expect("open live");
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
             )",
            [table],
            |row| row.get::<_, i64>(0),
        )? != 0)
    })
    .expect("inspect table")
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
fn schema_20_shadow_migrates_to_21_and_preserves_existing_rows() {
    assert_eq!(SCHEMA_VERSION, 21, "Gate C0 owns the SCHEMA 20 -> 21 step");
    let ws = temp_workspace("schema-20-to-21");
    let db_path = ws.join("grimodex.db");

    // Start from the complete current physical schema, remove only the Gate C0
    // tables, then stamp 20. This preserves the exact Gate B2 schema rather
    // than trying to maintain a second hand-written SCHEMA 20 fixture.
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate current");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-from-20', 'Preserve Me')",
                [],
            )?;
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 DROP TABLE narrative_change_events;
                 DROP TABLE narrative_change_transactions;
                 DROP TABLE narrative_change_cursors;
                 DROP TABLE narrative_change_sets;
                 PRAGMA user_version = 20;
                 PRAGMA foreign_keys = ON;",
            )?;
            Ok(())
        })
        .expect("shape schema 20 fixture");
    }
    assert_eq!(live_user_version(&ws), 20);
    assert!(!live_table_exists(&ws, "narrative_change_transactions"));

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("migrate 20");
    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            ..
        } => {
            assert_eq!(from_schema, 20);
            assert_eq!(to_schema, 21);
            drop(opened);
        }
        other => panic!("expected Migrated for SCHEMA 20, got {other:?}"),
    }

    assert_eq!(live_user_version(&ws), 21);
    for table in [
        "narrative_change_transactions",
        "narrative_change_events",
        "narrative_change_cursors",
        "narrative_change_sets",
    ] {
        assert!(
            live_table_exists(&ws, table),
            "missing migrated table {table}"
        );
    }
    let db = Database::new(&db_path).expect("reopen migrated");
    let title: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title FROM projects WHERE id = 'project-from-20'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("preserved row");
    assert_eq!(title, "Preserve Me");
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
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db"))
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
fn current_marker_missing_change_feed_index_is_shadow_repaired() {
    let ws = temp_workspace("missing-feed-index");
    let db_path = ws.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate current");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('preserved-index-repair', 'Keep')",
                [],
            )?;
            conn.execute_batch("DROP INDEX idx_narrative_change_events_project_sequence;")?;
            assert!(
                !grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
                "missing feed index must invalidate the current checkpoint"
            );
            Ok(())
        })
        .expect("shape missing-index fixture");
    }

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("repair");
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
        other => panic!("expected shadow repair, got {other:?}"),
    }

    let db = Database::new(&db_path).expect("reopen repaired");
    db.with_conn(|conn| {
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        let title: String = conn.query_row(
            "SELECT title FROM projects WHERE id = 'preserved-index-repair'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(title, "Keep");
        Ok(())
    })
    .expect("verify repaired workspace");
}

#[test]
fn current_marker_missing_change_feed_nullable_column_is_shadow_repaired() {
    let ws = temp_workspace("missing-feed-column");
    let db_path = ws.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate current");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('preserved-column-repair', 'Keep')",
                [],
            )?;
            conn.execute_batch(
                "ALTER TABLE narrative_change_transactions DROP COLUMN journal_id;",
            )?;
            assert!(
                !grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?,
                "missing nullable feed column must invalidate the current checkpoint"
            );
            Ok(())
        })
        .expect("shape missing-column fixture");
    }

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&ws).expect("repair");
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
        other => panic!("expected shadow repair, got {other:?}"),
    }

    let db = Database::new(&db_path).expect("reopen repaired");
    db.with_conn(|conn| {
        assert!(grimodex_core::workspace_schema::has_current_schema_checkpoint_invariants(conn)?);
        let journal_column: i64 = conn.query_row(
            "SELECT COUNT(*) FROM pragma_table_info('narrative_change_transactions')
              WHERE name = 'journal_id' AND type = 'TEXT' AND \"notnull\" = 0",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(journal_column, 1, "nullable journal_id must be restored");
        let title: String = conn.query_row(
            "SELECT title FROM projects WHERE id = 'preserved-column-repair'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(title, "Keep");
        Ok(())
    })
    .expect("verify repaired workspace");
}

#[test]
fn prepare_database_refuses_safe_mode_authority() {
    let newer_ws = temp_workspace("prep-newer");
    seed_legacy_db(&newer_ws.join("grimodex.db"), SCHEMA_VERSION + 3);
    let err = migration_supervisor::prepare_database_for_open(&newer_ws).expect_err("safe mode");
    assert!(err.to_string().contains("WORKSPACE_SAFE_MODE"), "err={err}");
}

#[cfg(feature = "test-failpoints")]
mod failpoint_tests {
    use super::*;

    #[test]
    fn failpoint_after_snapshot_enters_safe_mode_with_snapshot() {
        let ws = temp_workspace("fp-snapshot");
        let db_path = ws.join("grimodex.db");
        seed_legacy_db(&db_path, 0);
        let before = sha256_file(&db_path);

        let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
            &ws,
            Some(Failpoint::AfterSnapshot),
        )
        .expect("structured safe mode");
        match outcome {
            WorkspaceOpenDbOutcome::SafeMode {
                reason,
                available_backups,
            } => {
                assert!(
                    reason.contains("WORKSPACE_SAFE_MODE")
                        && (reason.contains("migration.after_snapshot")
                            || reason.contains("AfterSnapshot")
                            || reason.contains("snapshot=")),
                    "reason={reason}"
                );
                assert!(
                    available_backups.iter().any(|b| b.format == "migration-db"),
                    "snapshot should be listed: {available_backups:?}"
                );
            }
            other => panic!("expected SafeMode, got {other:?}"),
        }
        assert_eq!(sha256_file(&db_path), before);
        assert_eq!(live_user_version(&ws), 0);
        assert!(
            snapshot_still_present(&ws),
            "migration snapshot must survive AfterSnapshot failpoint"
        );
    }

    #[test]
    fn failpoint_after_migrate_enters_safe_mode_with_snapshot() {
        let ws = temp_workspace("fp-migrate");
        let db_path = ws.join("grimodex.db");
        seed_legacy_db(&db_path, 0);
        let before = sha256_file(&db_path);

        let outcome = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
            &ws,
            Some(Failpoint::AfterMigrate),
        )
        .expect("structured safe mode");
        match outcome {
            WorkspaceOpenDbOutcome::SafeMode {
                reason,
                available_backups,
            } => {
                assert!(
                    reason.contains("WORKSPACE_SAFE_MODE")
                        && (reason.contains("migration.after_migrate")
                            || reason.contains("AfterMigrate")
                            || reason.contains("snapshot=")),
                    "reason={reason}"
                );
                assert!(
                    available_backups.iter().any(|b| b.format == "migration-db"),
                    "snapshot should be listed: {available_backups:?}"
                );
            }
            other => panic!("expected SafeMode, got {other:?}"),
        }
        assert_eq!(sha256_file(&db_path), before);
        assert_eq!(live_user_version(&ws), 0);
        assert!(
            snapshot_still_present(&ws),
            "migration snapshot must survive AfterMigrate failpoint"
        );
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
        entries
            .flatten()
            .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db"))
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
                    available_backups.iter().any(|b| b.format == "migration-db"),
                    "migration snapshots must be recovery candidates: {available_backups:?}"
                );
            }
            other => panic!("expected RecoveryRequired, got {other:?}"),
        }
        assert_eq!(live_user_version(&ws), 0);
        assert!(snapshot_still_present(&ws));
    }

    #[test]
    fn failpoint_shared_handoff_busy_keeps_verified_migrated_live() {
        let ws = temp_workspace("fp-handoff-busy");
        let db_path = ws.join("grimodex.db");
        seed_legacy_db(&db_path, 0);

        let err = migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
            &ws,
            Some(Failpoint::SharedHandoffBusy),
        )
        .expect_err("handoff busy must not roll back");
        let msg = err.to_string();
        assert!(msg.contains("MIGRATION_HANDOFF_BUSY"), "msg={msg}");
        // Verified migration must remain published on disk — no blind snapshot restore.
        assert_eq!(live_user_version(&ws), SCHEMA_VERSION);
        assert!(snapshot_still_present(&ws));
    }

    #[test]
    fn handoff_busy_race_does_not_clobber_foreign_live_update() {
        use std::sync::{Arc, Barrier};
        use std::thread;
        use std::time::Duration;

        let ws = temp_workspace("handoff-race");
        let db_path = ws.join("grimodex.db");
        seed_legacy_db(&db_path, 0);

        // Thread A migrates then hits SharedHandoffBusy after exclusive drop.
        // Thread B installs a distinct live image under exclusive in that gap.
        // A must not roll the pre-migration snapshot over B's completed update.
        let barrier = Arc::new(Barrier::new(2));
        let ws_a = ws.clone();
        let ws_b = ws.clone();
        let db_b = db_path.clone();
        let barrier_a = Arc::clone(&barrier);
        let barrier_b = Arc::clone(&barrier);

        let a = thread::spawn(move || {
            barrier_a.wait();
            migration_supervisor::open_or_migrate_workspace_db_with_failpoint(
                &ws_a,
                Some(Failpoint::SharedHandoffBusy),
            )
        });

        let b = thread::spawn(move || {
            barrier_b.wait();
            let deadline = std::time::Instant::now() + Duration::from_secs(30);
            loop {
                if db_b.exists() {
                    if let Ok(db) = Database::new(&db_b) {
                        if let Ok(version) = db.with_conn(|conn| {
                            Ok(conn.pragma_query_value(None, "user_version", |row| {
                                row.get::<_, i32>(0)
                            })?)
                        }) {
                            if version == SCHEMA_VERSION {
                                drop(db);
                                if let Ok(exclusive) =
                                    grimodex_db::workspace_lease::acquire_exclusive(
                                        &ws_b,
                                        Duration::from_secs(5),
                                    )
                                {
                                    let foreign = ws_b.join("foreign.db");
                                    {
                                        let fdb = Database::new(&foreign).expect("foreign");
                                        fdb.migrate().expect("migrate foreign");
                                        fdb.with_conn(|conn| {
                                        conn.execute(
                                            "INSERT INTO projects (id, title, language) VALUES (?1, 'Foreign', 'ja')",
                                            ["project-foreign"],
                                        )?;
                                        Ok(())
                                    })
                                    .expect("seed foreign");
                                    }
                                    migration_supervisor::seal_sqlite_image(&foreign)
                                        .expect("seal foreign");
                                    fs::copy(&foreign, &db_b).expect("install foreign live");
                                    migration_supervisor::seal_sqlite_image(&db_b).expect("reseal");
                                    drop(exclusive);
                                    return;
                                }
                            }
                        }
                    }
                }
                if std::time::Instant::now() >= deadline {
                    panic!("timed out waiting for migrated live DB");
                }
                thread::sleep(Duration::from_millis(20));
            }
        });

        let a_result = a.join().expect("thread A");
        b.join().expect("thread B");

        let err = a_result.expect_err("A must not blind-rollback after handoff busy");
        assert!(
            err.to_string().contains("MIGRATION_HANDOFF_BUSY"),
            "err={}",
            err
        );

        let db = Database::new(&db_path).expect("open final live");
        let count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM projects WHERE id = 'project-foreign'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("count foreign");
        assert_eq!(
            count, 1,
            "Process B's completed update must survive A's handoff failure"
        );
    }
}

#[test]
fn rollback_cas_refuses_when_live_image_changed() {
    let ws = temp_workspace("cas-conflict");
    let db_path = ws.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate");
    }
    migration_supervisor::seal_sqlite_image(&db_path).expect("seal");
    let installed = migration_supervisor::capture_installed_image(
        &db_path,
        SCHEMA_VERSION,
        Some("mig-a".into()),
    )
    .expect("capture A");

    // Process B replaces live with a different sealed image.
    let other = ws.join("other.db");
    {
        let db = Database::new(&other).expect("other");
        db.migrate().expect("migrate other");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'B', 'ja')",
                ["project-b"],
            )?;
            Ok(())
        })
        .expect("seed B");
    }
    migration_supervisor::seal_sqlite_image(&other).expect("seal other");
    fs::copy(&other, &db_path).expect("B wins live");
    migration_supervisor::seal_sqlite_image(&db_path).expect("reseal live");

    let rollback = ws.join("rollback-a.db");
    fs::copy(&other, &rollback).expect("dummy rollback artifact");

    let err = migration_supervisor::rollback_if_installed_image_unchanged(
        &ws,
        &db_path,
        &rollback,
        &installed,
        "MIGRATION_HANDOFF_CONFLICT",
    )
    .expect_err("must refuse overwrite");
    let msg = err.to_string();
    assert!(msg.contains("MIGRATION_HANDOFF_CONFLICT"), "msg={msg}");

    // Live still has Process B's project row.
    let db = Database::new(&db_path).expect("open live");
    let count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE id = 'project-b'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("count");
    assert_eq!(count, 1);
}

#[test]
fn rollback_cas_applies_when_live_image_unchanged() {
    let ws = temp_workspace("cas-ok");
    let db_path = ws.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'Installed', 'ja')",
                ["project-installed"],
            )?;
            Ok(())
        })
        .expect("seed installed");
    }
    let installed = migration_supervisor::capture_installed_image(&db_path, SCHEMA_VERSION, None)
        .expect("capture");

    let rollback = ws.join("rollback.db");
    {
        let db = Database::new(&rollback).expect("rollback db");
        db.migrate().expect("migrate rollback");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title, language) VALUES (?1, 'Rollback', 'ja')",
                ["project-rollback"],
            )?;
            Ok(())
        })
        .expect("seed rollback");
    }
    migration_supervisor::seal_sqlite_image(&rollback).expect("seal rollback");

    let exclusive = migration_supervisor::rollback_if_installed_image_unchanged(
        &ws,
        &db_path,
        &rollback,
        &installed,
        "RESTORE_HANDOFF_CONFLICT",
    )
    .expect("cas rollback");
    drop(exclusive);

    let db = Database::new(&db_path).expect("open live");
    let title: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title FROM projects WHERE id = 'project-rollback'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("title");
    assert_eq!(title, "Rollback");
}

#[test]
fn sealed_staged_token_matches_live_after_replace_semantics() {
    let ws = temp_workspace("staged-token");
    let staged = ws.join("staged.db");
    let live = ws.join("grimodex.db");
    {
        let db = Database::new(&staged).expect("new staged");
        db.migrate().expect("migrate");
    }
    migration_supervisor::seal_sqlite_image(&staged).expect("seal staged");
    let installed = migration_supervisor::installed_image_token_from_sealed(
        &staged,
        SCHEMA_VERSION,
        Some("pre-replace".into()),
    )
    .expect("token from staged");

    // Atomic replace semantics: live receives the same sealed bytes.
    fs::copy(&staged, &live).expect("install live");
    assert!(
        migration_supervisor::installed_image_unchanged(&live, &installed).expect("cas"),
        "live must still match the pre-replace staged digest without re-capturing"
    );
}

#[test]
fn reopen_existing_current_authority_is_ddl_free_ready() {
    let ws = temp_workspace("reactivate");
    let db_path = ws.join("grimodex.db");
    {
        let db = Database::new(&db_path).expect("new");
        db.migrate().expect("migrate");
    }
    let opened = migration_supervisor::reopen_existing_current_authority(&ws).expect("reopen");
    assert_eq!(
        opened.lease.mode(),
        grimodex_db::workspace_lease::LeaseMode::Shared
    );
    drop(opened);
}

#[test]
fn exclusive_lease_contention_does_not_touch_live() {
    let ws = temp_workspace("lease");
    let db_path = ws.join("grimodex.db");
    seed_legacy_db(&db_path, 0);
    let before = sha256_file(&db_path);

    let _holder =
        grimodex_db::workspace_lease::acquire_exclusive(&ws, std::time::Duration::from_millis(50))
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
