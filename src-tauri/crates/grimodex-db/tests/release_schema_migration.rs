//! Gate A2 release-shaped migration fixtures.
//!
//! These tests use a previous-release marker on a populated database instead of
//! an empty `user_version` fixture, so the shadow migration path must preserve
//! the same user-facing rows a real workspace carries.

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

use grimodex_core::{PREVIOUS_COMPATIBLE_SCHEMA_VERSION, SCHEMA_VERSION};
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};

use release_schema_fixture::{
    assert_previous_release_snapshot_rows, assert_release_fixture_rows, latest_migration_snapshot,
    seed_previous_release_workspace, temp_workspace,
};

#[test]
fn previous_release_shaped_database_migrates_and_preserves_rows() {
    let workspace = temp_workspace("release-shaped");
    let db_path = seed_previous_release_workspace(&workspace);

    let outcome =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("shadow migrate");

    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            receipt_path,
        } => {
            assert_eq!(from_schema, PREVIOUS_COMPATIBLE_SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists(), "receipt should be written");
            drop(opened);
        }
        other => panic!("expected Migrated for previous-release fixture, got {other:?}"),
    }

    assert_release_fixture_rows(&db_path);
}

#[test]
fn committed_wal_frames_are_materialized_into_migration_snapshot() {
    let workspace = temp_workspace("wal-snapshot");
    let db_path = seed_previous_release_workspace(&workspace);
    assert!(
        db_path.with_extension("db-wal").exists(),
        "fixture setup should leave committed frames in the WAL sidecar"
    );

    let outcome =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("shadow migrate");
    match outcome {
        WorkspaceOpenDbOutcome::Migrated { opened, .. } => drop(opened),
        other => panic!("expected Migrated for dirty-WAL fixture, got {other:?}"),
    }

    let snapshot_path = latest_migration_snapshot(&workspace);
    assert_previous_release_snapshot_rows(&snapshot_path);
    assert_release_fixture_rows(&db_path);
}
