//! Gate A2 release-shaped migration fixtures.
//!
//! These tests stamp the last *public* Release marker (v2.0.10 / Schema 2) on
//! the published seed SQL — not the rolling PREVIOUS_COMPATIBLE_* bookkeeping
//! constant — so the shadow migration path proves the real user upgrade route.

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

use std::fs;

use grimodex_core::{LAST_PUBLIC_RELEASE_SCHEMA_VERSION, SCHEMA_VERSION};
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use serde_json::Value;

use release_schema_fixture::{
    assert_previous_release_fixture_shape, assert_previous_release_snapshot_rows,
    assert_release_fixture_rows, latest_migration_snapshot, seed_previous_release_workspace,
    temp_workspace,
};

#[test]
fn previous_release_shaped_database_migrates_and_preserves_rows() {
    assert_eq!(
        LAST_PUBLIC_RELEASE_SCHEMA_VERSION, 2,
        "the published v2.0.10 fixture must remain the public migration floor"
    );
    assert_eq!(
        SCHEMA_VERSION, 22,
        "Gate C1 migration target must be SCHEMA 22"
    );
    let workspace = temp_workspace("release-shaped");
    let db_path = seed_previous_release_workspace(&workspace);
    assert_previous_release_fixture_shape(&db_path);

    let outcome =
        migration_supervisor::open_or_migrate_workspace_db(&workspace).expect("shadow migrate");

    match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            from_schema,
            to_schema,
            opened,
            receipt_path,
        } => {
            assert_eq!(from_schema, LAST_PUBLIC_RELEASE_SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.exists(), "receipt should be written");
            let receipt: Value = serde_json::from_str(
                &fs::read_to_string(&receipt_path).expect("read migration receipt"),
            )
            .expect("parse migration receipt");
            assert_eq!(
                receipt["fromSchema"],
                Value::from(LAST_PUBLIC_RELEASE_SCHEMA_VERSION)
            );
            assert_eq!(receipt["toSchema"], Value::from(SCHEMA_VERSION));
            drop(opened);
        }
        other => panic!("expected Migrated for previous-release fixture, got {other:?}"),
    }

    let snapshot_path = latest_migration_snapshot(&workspace);
    let manifest_path = snapshot_path.with_extension("json");
    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&manifest_path).expect("read migration snapshot manifest"),
    )
    .expect("parse migration snapshot manifest");
    assert_eq!(
        manifest["sourceSchemaVersion"],
        Value::from(LAST_PUBLIC_RELEASE_SCHEMA_VERSION)
    );
    assert_eq!(manifest["targetSchemaVersion"], Value::from(SCHEMA_VERSION));

    assert_release_fixture_rows(&db_path);
}

#[test]
fn committed_wal_frames_are_materialized_into_migration_snapshot() {
    let workspace = temp_workspace("wal-snapshot");
    let db_path = seed_previous_release_workspace(&workspace);
    assert_previous_release_fixture_shape(&db_path);
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
