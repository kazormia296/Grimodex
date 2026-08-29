#![cfg(feature = "c2zc-fixture-builder")]

use grimodex_db::backup_restore::restore_backup_core;
use grimodex_db::domain_writes::{project_delete, ProjectDeletePayload};
use grimodex_db::narrative_extraction::c2zc_restore_fixture::{
    build_offline_restore_fixture, verify_manifest, verify_manifest_against_candidate,
    FixtureBuildOptions, FixtureBuildResult,
};
use grimodex_db::narrative_extraction::{
    canonical_application_freshness, cut_over_workspace_freshness, digest_plan,
    inspect_legacy_generic_freshness_parity, rebuild_narrative_derived_state_for_project,
    record_live_scheduler_heartbeat, run_dependency_verify_for_project,
    run_incremental_freshness_cycle_with_liveness_capability, RebuildDerivedStateOutcome,
    C2_ZC_CUTOVER_MIGRATION_ID,
};
use grimodex_db::{with_db_state, ActiveWorkspace, Database, WorkspaceAuthority, WorkspaceState};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{atomic::AtomicBool, Mutex};

fn candidate_and_output() -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "grimodex-c2zc-fixture-candidate-{}",
        uuid::Uuid::new_v4()
    ));
    let output = root.parent().expect("temp directory parent").join(format!(
        "grimodex-c2zc-fixture-output-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).expect("candidate directory");
    fs::write(root.join("candidate.txt"), "candidate\n").expect("candidate file");
    run_git(&root, &["init", "--quiet"]);
    run_git(&root, &["config", "user.name", "fixture"]);
    run_git(&root, &["config", "user.email", "fixture@example.invalid"]);
    run_git(&root, &["add", "candidate.txt"]);
    run_git(&root, &["commit", "--quiet", "-m", "candidate"]);
    (root, output)
}

fn run_git(root: &std::path::Path, args: &[&str]) {
    let status = Command::new("git")
        .current_dir(root)
        .args(args)
        .status()
        .expect("git");
    assert!(status.success(), "git {:?} failed", args);
}

#[test]
fn offline_restore_fixture_builder_has_a_candidate_bound_contract() {
    let (candidate, output) = candidate_and_output();
    let options = FixtureBuildOptions::new(&candidate, &output).with_builder_command(vec![
        "c2zc-restore-fixture".to_string(),
        "build".to_string(),
    ]);
    let result = build_offline_restore_fixture(options).expect("fixture builder");

    assert!(!result.manifest.c2zc_marker_present);
    assert_eq!(result.manifest.semantic.project_count, 1);
    assert_eq!(result.manifest.semantic.scene_count, 1);
    assert_eq!(result.manifest.semantic.e0_count, 1);
    assert_eq!(result.manifest.semantic.completed_backfill_count, 1);
    assert_eq!(result.manifest.semantic.application_count, 1);
    assert_eq!(
        result.manifest.semantic.legacy_projection_freshness_count,
        1
    );
    assert_eq!(
        result.manifest.semantic.legacy_projection_dependency_count,
        1
    );
    assert_eq!(result.manifest.semantic.application_edge_count, 1);
    assert_eq!(result.manifest.semantic.application_edge_state_count, 0);
    assert_eq!(result.manifest.semantic.application_freshness_count, 0);
    assert!(!result.manifest.semantic.application_id.is_empty());
    assert_eq!(
        result.manifest.semantic.edge["consumerKind"],
        Value::String("application".to_string())
    );
    assert_eq!(
        result.manifest.semantic.edge["consumerKey"],
        Value::String(result.manifest.semantic.application_id.clone())
    );
    let expected_gap = &result.manifest.semantic.expected_restore_gap;
    let expected_edges = expected_gap["edgeIdsWithoutCurrentEpochState"]
        .as_array()
        .expect("expected restore gap edge inventory");
    assert_eq!(expected_edges.len(), 2);
    assert!(expected_edges.iter().any(|edge| {
        edge["consumerKind"] == Value::String("application".to_string())
            && edge["consumerKey"] == Value::String(result.manifest.semantic.application_id.clone())
            && edge["id"].as_str().is_some_and(|id| !id.is_empty())
    }));
    assert!(expected_edges.iter().any(|edge| {
        edge["consumerKind"] == Value::String("proposal-revision".to_string())
            && edge["consumerKey"] == result.manifest.semantic.application["revisionId"]
            && edge["id"].as_str().is_some_and(|id| !id.is_empty())
    }));
    assert_eq!(
        expected_gap["consumerKeysWithoutCurrentEpochFreshness"]
            .as_array()
            .expect("expected restore gap consumer inventory")
            .len(),
        2
    );
    assert_eq!(
        result.manifest.semantic.application["id"],
        Value::String(result.manifest.semantic.application_id.clone())
    );
    assert_eq!(
        result.manifest.semantic.application["runStatus"],
        Value::String("completed".to_string())
    );
    assert_eq!(
        result.manifest.semantic.application["commitStatus"],
        Value::String("applied".to_string())
    );
    assert_eq!(
        result.manifest.semantic.legacy_projection["freshness"]["applicationId"],
        Value::String(result.manifest.semantic.application_id.clone())
    );
    assert_eq!(
        result.manifest.semantic.expected_restore_lifecycle["marker"],
        Value::String("after-confirmation-verify".to_string())
    );
    assert_eq!(result.manifest.semantic.semantic_index_rows, 0);
    assert!(result.manifest.semantic.cursor_settled);
    assert_eq!(
        result.manifest.fixture_sha256,
        result.manifest.artifacts.fixture.sha256
    );
    assert_eq!(
        result.manifest.fixture_size_bytes,
        result.manifest.artifacts.fixture.size_bytes
    );
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!result
            .database_path
            .with_file_name(format!(
                "{}{}",
                result.database_path.file_name().unwrap().to_string_lossy(),
                suffix
            ))
            .exists());
    }
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_builder_rejects_dirty_candidate() {
    let (candidate, output) = candidate_and_output();
    fs::write(candidate.join("dirty.txt"), "dirty\n").expect("dirty marker");
    let options = FixtureBuildOptions::new(&candidate, &output);

    let error = build_offline_restore_fixture(options).expect_err("dirty candidate must fail");
    assert!(error.to_string().contains("C2ZC_FIXTURE_CANDIDATE_DIRTY"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
}

#[test]
fn offline_restore_fixture_drives_production_verify_rebuild_verify() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let (_restore_workspace, restore_state) =
        restore_fixture_through_production_path(&result, &output);
    let restore_epoch = assert_restore_epoch_boundary(&restore_state);
    let e0_id = result.manifest.semantic.epoch["rows"][0]["id"]
        .as_str()
        .expect("fixture E0 id");
    assert_ne!(restore_epoch, e0_id);
    assert_legacy_projection_unchanged(
        &restore_state,
        &result.manifest.semantic.application_id,
        &result.manifest.semantic.legacy_projection,
        &result.manifest.semantic.legacy_projection_digest,
    );
    assert_semantic_index_footprint_is_zero(&restore_state);
    let initial = with_db_state(&restore_state, |db| {
        run_dependency_verify_for_project(db, "c2zc-restore-fixture-project")
    })
    .expect("initial Verify");
    assert!(!initial.report.has_consistency_issues());
    assert!(initial.report.is_incomplete_only());
    assert!(initial.report.requires_rebuild());
    let (expected_edge_ids, expected_consumer_keys) =
        expected_restore_gap_vectors(&result.manifest.semantic.expected_restore_gap);
    assert_eq!(
        initial.report.edge_ids_without_current_epoch_state,
        expected_edge_ids
    );
    assert_eq!(
        initial.report.consumer_keys_without_current_epoch_freshness,
        expected_consumer_keys
    );
    assert_legacy_parity_vectors(
        &restore_state,
        &result.manifest.semantic.application_id,
        false,
    );
    assert!(initial
        .report
        .legacy_mirror_migration_parity
        .incomplete
        .iter()
        .any(|item| item
            == &format!(
                "application:{}:generic-freshness-missing",
                result.manifest.semantic.application_id
            )));
    let rebuild = with_db_state(&restore_state, |db| {
        rebuild_narrative_derived_state_for_project(db, "c2zc-restore-fixture-project")
    })
    .expect("conditional Rebuild");
    assert!(matches!(rebuild, RebuildDerivedStateOutcome::Ran { .. }));
    assert_legacy_projection_unchanged(
        &restore_state,
        &result.manifest.semantic.application_id,
        &result.manifest.semantic.legacy_projection,
        &result.manifest.semantic.legacy_projection_digest,
    );
    assert_semantic_index_footprint_is_zero(&restore_state);
    let confirmation = with_db_state(&restore_state, |db| {
        run_dependency_verify_for_project(db, "c2zc-restore-fixture-project")
    })
    .expect("confirmation Verify");
    assert!(confirmation.report.is_consistent());
    assert!(confirmation.report.is_complete());
    assert!(!confirmation.report.requires_rebuild());
    assert!(confirmation
        .report
        .edge_ids_without_current_epoch_state
        .is_empty());
    assert!(confirmation
        .report
        .consumer_keys_without_current_epoch_freshness
        .is_empty());
    assert!(confirmation.report.legacy_mirror_migration_parity.passed);
    assert_legacy_parity_vectors(
        &restore_state,
        &result.manifest.semantic.application_id,
        true,
    );
    with_db_state(&restore_state, |db| {
        db.with_conn(|conn| {
            let (edge_state_epoch, edge_state_freshness): (String, String) = conn.query_row(
                "SELECT evaluated_at_epoch_id, evidence_freshness
                   FROM narrative_dependency_edge_states
                  WHERE project_id = ?1 AND edge_id = ?2",
                rusqlite::params![
                    result.manifest.semantic.project_id,
                    result.manifest.semantic.edge["id"]
                        .as_str()
                        .expect("application edge id")
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let current_epoch: String = conn.query_row(
                "SELECT id FROM narrative_semantic_epochs
                  WHERE project_id = ?1
                  ORDER BY epoch_number DESC LIMIT 1",
                rusqlite::params![result.manifest.semantic.project_id],
                |row| row.get(0),
            )?;
            assert_eq!(current_epoch, restore_epoch);
            assert_eq!(edge_state_epoch, current_epoch);
            assert_eq!(edge_state_freshness, "fresh");
            let (freshness_epoch, freshness_status): (String, String) = conn.query_row(
                "SELECT semantic_epoch_id, evidence_freshness
                   FROM narrative_consumer_freshness
                  WHERE project_id = ?1
                    AND consumer_kind = 'application'
                    AND consumer_key = ?2",
                rusqlite::params![
                    result.manifest.semantic.project_id,
                    result.manifest.semantic.application_id
                ],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(freshness_epoch, current_epoch);
            assert_eq!(freshness_status, "fresh");
            Ok::<_, anyhow::Error>(())
        })
    })
    .expect("rebuild publishes current-epoch application state");

    let (_cycle, liveness_capability) = with_db_state(&restore_state, |db| {
        run_incremental_freshness_cycle_with_liveness_capability(db)
    })
    .expect("successful confirmation scheduler cycle");
    let liveness = with_db_state(&restore_state, |db| {
        record_live_scheduler_heartbeat(
            db,
            "c2zc-restore-fixture-test-scheduler",
            1,
            liveness_capability,
        )
    })
    .expect("register confirmation scheduler liveness");
    let cutover = with_db_state(&restore_state, |db| {
        db.with_conn(|conn| cut_over_workspace_freshness(conn, &liveness))
    })
    .expect("cut over after confirmation Verify");
    assert_eq!(cutover.migration_id, C2_ZC_CUTOVER_MIGRATION_ID);
    let canonical = with_db_state(&restore_state, |db| {
        db.with_conn(|conn| {
            canonical_application_freshness(
                conn,
                &result.manifest.semantic.project_id,
                &result.manifest.semantic.application_id,
            )
        })
    })
    .expect("read canonical Application freshness after marker")
    .expect("Application freshness after marker");
    assert_eq!(canonical.evidence_freshness, "fresh");
    assert_legacy_projection_unchanged(
        &restore_state,
        &result.manifest.semantic.application_id,
        &result.manifest.semantic.legacy_projection,
        &result.manifest.semantic.legacy_projection_digest,
    );
    assert_semantic_index_footprint_is_zero(&restore_state);
    with_db_state(&restore_state, |db| {
        db.with_conn(|conn| {
            let marker_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
                [C2_ZC_CUTOVER_MIGRATION_ID],
                |row| row.get(0),
            )?;
            assert_eq!(marker_count, 1);
            Ok::<_, anyhow::Error>(())
        })
    })
    .expect("C2-ZC marker after lifecycle");

    drop(restore_state);
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

const RESTORE_BACKUP_NAME: &str = "grimodex-c2zc-restore-fixture.db";

fn restore_fixture_through_production_path(
    result: &FixtureBuildResult,
    output: &Path,
) -> (PathBuf, WorkspaceState) {
    let workspace = output.join("production-restore-workspace");
    fs::create_dir_all(workspace.join("backups")).expect("restore workspace");
    fs::copy(
        &result.backup_path,
        workspace.join("backups").join(RESTORE_BACKUP_NAME),
    )
    .expect("copy fixture backup into production restore candidate");

    let live_db_path = workspace.join("grimodex.db");
    let live_db = Database::new(&live_db_path).expect("open live restore target");
    live_db.migrate().expect("migrate live restore target");
    let authority = WorkspaceAuthority::from_database_for_test(live_db, workspace.clone())
        .expect("publish live workspace authority");
    let state = WorkspaceState {
        inner: Mutex::new(Some(ActiveWorkspace::new(authority))),
        safe_mode: grimodex_db::recovery::SafeModeState::default(),
        switching: AtomicBool::new(false),
        open_lock: Mutex::new(()),
    };
    restore_backup_core(&state, RESTORE_BACKUP_NAME, || {})
        .expect("install fixture through production restore_backup_core");
    // The production restore preflight runs the idempotent full migration on
    // the staged copy; that migration seeds the fresh-workspace bootstrap
    // project even when the backup is otherwise current.  Remove only that
    // known migration bootstrap through the same trusted domain writer used
    // by the fixture builder, so cutover readiness covers the fixture's one
    // restored project rather than an unrelated migration artifact.
    assert_project_ids(&state, &["c2zc-restore-fixture-project", "default-project"]);
    with_db_state(&state, |db| {
        project_delete(
            db,
            ProjectDeletePayload {
                project_id: "default-project".to_string(),
            },
        )
        .map_err(Into::into)
    })
    .expect("remove production migration bootstrap project through typed writer");
    assert_project_ids(&state, &["c2zc-restore-fixture-project"]);
    (workspace, state)
}

fn assert_project_ids(state: &WorkspaceState, expected: &[&str]) {
    let actual = with_db_state(state, |db| {
        db.with_conn(|conn| {
            let mut statement = conn.prepare("SELECT id FROM projects ORDER BY id ASC")?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(ids)
        })
    })
    .expect("read restored project set");
    assert_eq!(
        actual,
        expected
            .iter()
            .map(|id| (*id).to_string())
            .collect::<Vec<_>>()
    );
}

fn assert_legacy_parity_vectors(
    state: &WorkspaceState,
    application_id: &str,
    generic_row_present: bool,
) {
    let parity = with_db_state(state, |db| {
        db.with_conn(|conn| {
            inspect_legacy_generic_freshness_parity(conn, "c2zc-restore-fixture-project")
        })
    })
    .expect("read Legacy/Generic parity vectors");
    let application_ids = vec![application_id.to_string()];
    let generic_application_ids = if generic_row_present {
        application_ids.clone()
    } else {
        Vec::new()
    };
    let missing_generic_application_ids = if generic_row_present {
        Vec::new()
    } else {
        application_ids.clone()
    };
    assert_eq!(parity.legacy_application_ids, application_ids);
    assert_eq!(parity.generic_application_ids, generic_application_ids);
    assert!(parity.missing_legacy_application_ids.is_empty());
    assert_eq!(
        parity.missing_generic_application_ids,
        missing_generic_application_ids
    );
    assert!(parity.status_mismatches.is_empty());
    assert!(parity.dependency_mismatches.is_empty());
    assert!(parity.unsupported_generic_values.is_empty());
    assert!(parity.invalid_legacy_dependencies.is_empty());
}

fn expected_restore_gap_vectors(gap: &Value) -> (Vec<String>, Vec<(String, String)>) {
    let edge_ids = gap["edgeIdsWithoutCurrentEpochState"]
        .as_array()
        .expect("expected restore gap edge inventory")
        .iter()
        .map(|edge| {
            edge["id"]
                .as_str()
                .expect("expected restore gap edge id")
                .to_string()
        })
        .collect();
    let consumer_keys = gap["consumerKeysWithoutCurrentEpochFreshness"]
        .as_array()
        .expect("expected restore gap consumer inventory")
        .iter()
        .map(|consumer| {
            (
                consumer["consumerKind"]
                    .as_str()
                    .expect("expected restore gap consumer kind")
                    .to_string(),
                consumer["consumerKey"]
                    .as_str()
                    .expect("expected restore gap consumer key")
                    .to_string(),
            )
        })
        .collect();
    (edge_ids, consumer_keys)
}

fn assert_restore_epoch_boundary(state: &WorkspaceState) -> String {
    with_db_state(state, |db| {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, epoch_number, reason, triggered_by_change_event_uid
                   FROM narrative_semantic_epochs
                  WHERE project_id = ?1
                  ORDER BY epoch_number ASC, id ASC",
            )?;
            let epochs = statement
                .query_map(["c2zc-restore-fixture-project"], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            anyhow::ensure!(
                epochs.len() == 2,
                "restore must leave exactly E0 and E1, found {}",
                epochs.len()
            );
            let e0 = epochs
                .iter()
                .find(|(_, epoch_number, _, _)| *epoch_number == 0)
                .ok_or_else(|| anyhow::anyhow!("restore fixture E0 missing"))?;
            anyhow::ensure!(e0.2 == "initial", "fixture E0 reason changed: {}", e0.2);
            let e1 = epochs
                .iter()
                .find(|(_, epoch_number, _, _)| *epoch_number == 1)
                .ok_or_else(|| anyhow::anyhow!("restore fixture E1 missing"))?;
            anyhow::ensure!(
                e1.2 == "restore"
                    && e1
                        .3
                        .as_deref()
                        .is_some_and(|identity| identity.starts_with("restore-image-sha256:"))
                    && e1.0 != e0.0,
                "restore fixture E1 boundary invalid: {:?}",
                e1
            );
            let current_id: String = conn.query_row(
                "SELECT id FROM narrative_semantic_epochs
                  WHERE project_id = ?1
                  ORDER BY epoch_number DESC, id DESC LIMIT 1",
                ["c2zc-restore-fixture-project"],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                current_id == e1.0,
                "restore fixture current epoch is not E1: current={} e1={}",
                current_id,
                e1.0
            );
            Ok(e1.0.clone())
        })
    })
    .expect("inspect production restore E1 boundary")
}

fn assert_legacy_projection_unchanged(
    state: &WorkspaceState,
    application_id: &str,
    expected: &Value,
    expected_digest: &str,
) {
    let actual = with_db_state(state, |db| {
        db.with_conn(|conn| {
            let (status, reason_json, version, updated_at): (String, Option<String>, i64, String) =
                conn.query_row(
                    "SELECT status, reason_json, version, updated_at
                   FROM narrative_projection_freshness
                  WHERE application_id = ?1",
                    [application_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            let reason = reason_json
                .map(|raw| serde_json::from_str::<Value>(&raw))
                .transpose()?
                .unwrap_or(Value::Null);
            let mut statement = conn.prepare(
                "SELECT source_kind, source_key, observed_revision_token, propagation
                   FROM narrative_projection_dependencies
                  WHERE application_id = ?1
                  ORDER BY source_kind, source_key",
            )?;
            let dependencies = statement
                .query_map([application_id], |row| {
                    Ok(json!({
                        "sourceKind": row.get::<_, String>(0)?,
                        "sourceKey": row.get::<_, String>(1)?,
                        "observedRevisionToken": row.get::<_, String>(2)?,
                        "propagation": row.get::<_, String>(3)?,
                    }))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(json!({
                "freshness": {
                    "applicationId": application_id,
                    "status": status,
                    "reasonJson": reason,
                    "version": version,
                    "updatedAt": updated_at,
                },
                "dependencies": dependencies,
            }))
        })
    })
    .expect("read restored Legacy projection snapshot");
    assert_eq!(&actual, expected, "Legacy projection snapshot changed");
    assert_eq!(
        format!("sha256:{}", digest_plan(&actual)),
        expected_digest,
        "Legacy projection digest changed"
    );
}

fn assert_semantic_index_footprint_is_zero(state: &WorkspaceState) {
    let footprint = with_db_state(state, |db| {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_semantic_index_metadata WHERE project_id = ?1),
                    (SELECT COUNT(*) FROM narrative_dependency_declaration_heads
                      WHERE project_id = ?1 AND consumer_kind = 'semantic-index'),
                    (SELECT COUNT(*) FROM narrative_dependency_edges
                      WHERE project_id = ?1 AND consumer_kind = 'semantic-index'),
                    (SELECT COUNT(*) FROM narrative_consumer_freshness
                      WHERE project_id = ?1 AND consumer_kind = 'semantic-index')",
                ["c2zc-restore-fixture-project"],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(Into::into)
        })
    })
    .expect("read reserved Semantic Index footprint");
    assert_eq!(footprint, (0, 0, 0, 0));
}

#[test]
fn offline_restore_fixture_manifest_rejects_tampered_backup() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let mut bytes = fs::read(&result.backup_path).expect("read fixture backup");
    let last = bytes.len() - 1;
    bytes[last] ^= 0x01;
    fs::write(&result.backup_path, bytes).expect("tamper fixture backup");

    let error = verify_manifest(&result.manifest_path).expect_err("tamper must fail closed");
    assert!(error.to_string().contains("C2ZC_FIXTURE_HASH_MISMATCH"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_manifest_rejects_artifact_path_escape() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(&result.manifest_path).expect("read manifest"))
            .expect("manifest JSON");
    manifest["artifacts"]["fixture"]["path"] = Value::String("../outside.db".to_string());
    let tampered = output.join("tampered.manifest.json");
    fs::write(
        &tampered,
        serde_json::to_vec_pretty(&manifest).expect("tampered JSON"),
    )
    .expect("write tampered manifest");

    let error = verify_manifest(&tampered).expect_err("path escape must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_ARTIFACT_PATH_ESCAPE"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rejects_output_inside_candidate_before_writing() {
    let (candidate, _) = candidate_and_output();
    let output = candidate.join("generated");
    let error = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect_err("candidate-contained output must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_OUTPUT_INSIDE_CANDIDATE"));
    let status = Command::new("git")
        .current_dir(&candidate)
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .output()
        .expect("git status");
    assert!(status.status.success());
    assert!(
        status.stdout.is_empty(),
        "output rejection dirtied candidate"
    );
    fs::remove_dir_all(candidate).expect("candidate cleanup");
}

#[test]
fn offline_restore_fixture_rechecks_candidate_binding() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    verify_manifest_against_candidate(&result.manifest_path, &candidate, None)
        .expect("candidate binding");
    fs::write(candidate.join("changed.txt"), "dirty\n").expect("dirty candidate");
    let error = verify_manifest_against_candidate(&result.manifest_path, &candidate, None)
        .expect_err("dirty candidate must fail verification");
    assert!(error.to_string().contains("C2ZC_FIXTURE_CANDIDATE_DIRTY"));
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rechecks_candidate_before_manifest_publication() {
    let (candidate, output) = candidate_and_output();
    let options =
        FixtureBuildOptions::new(&candidate, &output).with_before_manifest_publish_hook(|root| {
            fs::write(
                root.join("changed-during-build.txt"),
                "changed while the fixture was being generated\n",
            )
            .map_err(anyhow::Error::from)?;
            run_git(root, &["add", "changed-during-build.txt"]);
            run_git(root, &["commit", "--quiet", "-m", "candidate-during-build"]);
            Ok(())
        });

    let error = build_offline_restore_fixture(options)
        .expect_err("candidate mutation during build must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_CANDIDATE_CHANGED_BEFORE_MANIFEST"));
    assert!(
        !output.join("c2zc-restore-fixture.manifest.json").exists(),
        "candidate recheck failure must not publish a manifest"
    );
    assert!(
        !output.join("c2zc-restore-fixture.db").exists(),
        "candidate recheck failure must clean the database artifact"
    );
    assert!(
        !output.join("c2zc-restore-fixture.backup.db").exists(),
        "candidate recheck failure must clean the fixture artifact"
    );
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_manifest_recomputes_every_semantic_digest_and_matches_db() {
    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let original: Value =
        serde_json::from_slice(&fs::read(&result.manifest_path).expect("read manifest"))
            .expect("manifest JSON");

    let semantic_fields = [
        ("/semantic/project", "project"),
        ("/semantic/projectDigest", "project digest"),
        ("/semantic/scene", "scene"),
        ("/semantic/sceneDigest", "scene digest"),
        ("/semantic/epoch", "epoch"),
        ("/semantic/epochDigest", "epoch digest"),
        ("/semantic/backfill", "backfill"),
        ("/semantic/backfillDigest", "backfill digest"),
        ("/semantic/application", "application"),
        ("/semantic/applicationDigest", "application digest"),
        ("/semantic/legacyProjection", "legacy projection"),
        (
            "/semantic/legacyProjectionDigest",
            "legacy projection digest",
        ),
        ("/semantic/edge", "edge"),
        ("/semantic/edgeDigest", "edge digest"),
        ("/semantic/feedCursor", "feed cursor"),
        ("/semantic/feedCursorDigest", "feed cursor digest"),
        ("/semantic/derivedStateGap", "derived state gap"),
        (
            "/semantic/derivedStateGapDigest",
            "derived state gap digest",
        ),
        ("/semantic/expectedRestoreGap", "expected restore gap"),
        (
            "/semantic/expectedRestoreGapDigest",
            "expected restore gap digest",
        ),
        ("/semantic/semanticIndex", "semantic index"),
        ("/semantic/semanticIndexDigest", "semantic index digest"),
        (
            "/semantic/expectedRestoreLifecycle",
            "expected restore lifecycle",
        ),
        (
            "/semantic/expectedRestoreLifecycleDigest",
            "expected restore lifecycle digest",
        ),
        ("/semantic/contentsDigest", "contents digest"),
    ];
    for (path, label) in semantic_fields {
        let mut tampered = original.clone();
        let target = tampered
            .pointer_mut(path)
            .unwrap_or_else(|| panic!("manifest field missing for {label}: {path}"));
        *target = if path.ends_with("Digest") {
            Value::String(format!("sha256:{}", "0".repeat(64)))
        } else {
            serde_json::json!({ "tampered": label })
        };
        let tampered_path = output.join(format!(
            "tampered-{}.manifest.json",
            path.replace(['.', '/'], "-")
        ));
        fs::write(
            &tampered_path,
            serde_json::to_vec_pretty(&tampered).expect("tampered JSON"),
        )
        .expect("write tampered manifest");
        let error = verify_manifest(&tampered_path)
            .expect_err("semantic payload or digest mutation must fail closed");
        assert!(
            error.to_string().contains("C2ZC_FIXTURE_SEMANTIC_DIGEST"),
            "{label} mutation produced an unexpected error: {error:#}"
        );
    }

    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}

#[test]
fn offline_restore_fixture_rejects_expected_head_or_tree_mismatch() {
    for (expected_head, expected_tree, expected_code) in [
        (
            Some("0".repeat(40)),
            None,
            "C2ZC_FIXTURE_CANDIDATE_HEAD_MISMATCH",
        ),
        (
            None,
            Some("0".repeat(40)),
            "C2ZC_FIXTURE_CANDIDATE_TREE_MISMATCH",
        ),
    ] {
        let (candidate, output) = candidate_and_output();
        let mut options = FixtureBuildOptions::new(&candidate, &output);
        if let Some(expected) = expected_head {
            options = options.with_expected_head(expected);
        }
        if let Some(expected) = expected_tree {
            options = options.with_expected_tree(expected);
        }
        let error = build_offline_restore_fixture(options)
            .expect_err("mismatched candidate binding must fail closed");
        assert!(error.to_string().contains(expected_code));
        assert!(
            !output.exists(),
            "candidate binding mismatch must not create an output directory"
        );
        fs::remove_dir_all(candidate).expect("candidate cleanup");
    }
}

#[cfg(unix)]
#[test]
fn offline_restore_fixture_rejects_symlinked_candidate_and_artifact_paths() {
    use std::os::unix::fs::symlink;

    let (candidate, output) = candidate_and_output();
    let candidate_alias = output
        .parent()
        .expect("temp directory parent")
        .join(format!(
            "grimodex-c2zc-fixture-candidate-alias-{}",
            uuid::Uuid::new_v4()
        ));
    symlink(&candidate, &candidate_alias).expect("candidate symlink");
    let error = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate_alias, &output))
        .expect_err("symlinked candidate must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_SYMLINK_PATH_REJECTED"));
    assert!(!output.exists());
    fs::remove_file(candidate_alias).expect("candidate alias cleanup");
    fs::remove_dir_all(candidate).expect("candidate cleanup");

    let (candidate, output) = candidate_and_output();
    let result = build_offline_restore_fixture(FixtureBuildOptions::new(&candidate, &output))
        .expect("fixture builder");
    let outside = output
        .parent()
        .expect("temp directory parent")
        .join(format!(
            "grimodex-c2zc-fixture-outside-{}",
            uuid::Uuid::new_v4()
        ));
    fs::write(&outside, b"not the fixture").expect("outside file");
    fs::remove_file(&result.backup_path).expect("remove backup before symlink");
    symlink(&outside, &result.backup_path).expect("backup symlink");
    let error = verify_manifest(&result.manifest_path)
        .expect_err("symlinked fixture artifact must fail closed");
    assert!(error
        .to_string()
        .contains("C2ZC_FIXTURE_SYMLINK_PATH_REJECTED"));
    fs::remove_file(&result.backup_path).expect("backup symlink cleanup");
    fs::remove_file(outside).expect("outside file cleanup");
    fs::remove_dir_all(candidate).expect("candidate cleanup");
    fs::remove_dir_all(output).expect("output cleanup");
}
