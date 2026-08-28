//! C2-ZC public cutover contract.
//!
//! These tests describe the externally visible boundary. They do not exercise
//! a private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use grimodex_core::{LAST_PUBLIC_RELEASE_SCHEMA_VERSION, SCHEMA_VERSION};
use grimodex_db::migration_supervisor::{self, WorkspaceOpenDbOutcome};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::maintenance_skip_evidence::{
    durable_graph_state_digest, persist_completed_run_skip_evidence_in_tx, CompletedRunSkipEvidence,
};
use grimodex_db::narrative_extraction::{
    bootstrap_legacy_dependency_backfill_for_project, canonical_application_freshness,
    canonical_verify_outcome_digest, current_maintenance_coordinates, cut_over_workspace_freshness,
    digest_plan, ensure_test_schema, inspect_workspace_cutover_readiness_with_liveness,
    narrative_extraction_append_human_decision, narrative_extraction_apply_commit,
    narrative_extraction_create_run, narrative_extraction_prepare_commit,
    narrative_extraction_save_proposal_set, production_verify_check_coverage,
    rebuild_narrative_derived_state_for_project, record_live_scheduler_heartbeat,
    run_dependency_verify_for_project, run_incremental_freshness_cycle,
    run_incremental_freshness_cycle_with_liveness_capability,
    verify_narrative_dependency_graph_for_project, AppendDecisionPayload, ApplyCommitPayload,
    CanonicalFreshnessAuthority, CommitApplicationRef, CommitOperation, CreateRunPayload,
    CreateTaskSeed, DependencyGraphVerifyReport, PrepareCommitPayload, ProposalSeed,
    ReadinessState, SaveProposalSetPayload, SchedulerLivenessEvidence,
    C2_ZC_CUTOVER_CONTRACT_VERSION, C2_ZC_CUTOVER_MIGRATION_ID, REBUILD_DERIVED_WORK_KEY,
    VERIFY_RUN_KIND_CONTRACT_VERSION, VERIFY_WORK_KEY_PREFIX,
};
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

const PROJECT_ID: &str = "project-c2zc";
const EPOCH_ID: &str = "epoch-c2zc";
const APPLICATION_ID: &str = "application-c2zc";
const SOURCE_IDENTITY: &str = "project:scene:scene-c2zc";
const EXPECTED_UPGRADE_PROJECT_IDS: [&str; 2] = release_schema_fixture::LEGACY_PROJECT_IDS;
const NOW: &str = "2026-08-24T00:00:00.000Z";
const BACKFILL_CREATED_AT: &str = "2026-08-24T00:00:00.000Z";
const BACKFILL_STARTED_AT: &str = "2026-08-24T00:00:00.001Z";
const BACKFILL_AT: &str = "2026-08-24T00:00:00.002Z";
const REBUILD_CREATED_AT: &str = "2026-08-24T00:00:00.003Z";
const REBUILD_STARTED_AT: &str = "2026-08-24T00:00:00.004Z";
const REBUILD_AT: &str = "2026-08-24T00:00:00.005Z";
const VERIFY_CREATED_AT: &str = "2026-08-24T00:00:00.006Z";
const VERIFY_STARTED_AT: &str = "2026-08-24T00:00:00.007Z";
const VERIFY_AT: &str = "2026-08-24T00:00:00.008Z";
const BASELINE_RUN_ID: &str = "backfill-c2zc";
const BASELINE_VERIFY_RUN_ID: &str = "verify-c2zc";
const BASELINE_REBUILD_RUN_ID: &str = "rebuild-c2zc";
const BASELINE_FRESHNESS_RUN_ID: &str = "freshness-c2zc";

static LIVENESS_TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn serialize_liveness_test() -> std::sync::MutexGuard<'static, ()> {
    LIVENESS_TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

type ConsumerFreshnessRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

type EdgeFreshnessRow = (String, String, Option<String>, String, String, String);

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        // `Database::migrate()` materialises a default project for the
        // application shell.  This workspace-scoped contract fixture owns a
        // single project; leaving that seed row would correctly make C2-ZA
        // report the unseeded project's current epoch as missing.
        conn.execute("DELETE FROM projects WHERE id = 'default-project'", [])?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-ZC fixture')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, NOW],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES (?1, ?2, 'scene', 'C2-ZC scene', '{}', 0, ?3)",
            params!["scene-c2zc", PROJECT_ID, NOW],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn scheduler_evidence(project_ids: &[&str]) -> SchedulerLivenessEvidence {
    SchedulerLivenessEvidence {
        scheduler_instance_id: "scheduler-c2zc-test".to_string(),
        observed_at: NOW.to_string(),
        project_ids: project_ids.iter().map(|id| (*id).to_string()).collect(),
    }
}

fn scheduler_heartbeat(
    db: &Database,
    authority_id: &str,
    generation: u64,
) -> SchedulerLivenessEvidence {
    let (_outcome, successful_cycle) =
        grimodex_db::narrative_extraction::run_incremental_freshness_cycle_with_liveness_capability(db)
            .expect("run successful scheduler cycle before liveness receipt");
    record_live_scheduler_heartbeat(db, authority_id, generation, successful_cycle)
        .expect("mint capability-bound live scheduler receipt")
}

#[test]
fn database_only_liveness_never_becomes_cutover_evidence() {
    let db = fixture_db();

    db.with_conn(|conn| {
        let durable = inspect_workspace_cutover_readiness_with_liveness(conn, None)?;
        assert!(!durable.ready);
        assert_eq!(durable.state, ReadinessState::Incomplete);
        assert!(durable
            .reasons
            .iter()
            .any(|reason| reason == "scheduler-liveness-evidence-required"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("readiness report");
}

#[test]
fn cutover_refuses_incomplete_workspace_before_any_authority_marker() {
    let db = fixture_db();

    let error = db
        .with_conn(|conn| {
            let error = cut_over_workspace_freshness(conn, &scheduler_evidence(&[PROJECT_ID]))
                .expect_err("incomplete durable gates must block C2-ZC");
            Ok::<_, anyhow::Error>(error)
        })
        .expect("read cutover error");

    assert!(error.to_string().contains("NEX_C2ZC_CUTOVER_NOT_READY"));
    db.with_conn(|conn| {
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("cutover must not write a marker when blocked");
}

#[test]
fn cutover_phase_lifecycle_uses_the_exact_shared_task_owner() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed cutover fixture");
    db.with_conn(|conn| {
        // The individual Rebuild row remains otherwise current and
        // completed.  Only its task owner is forged: a weak `COUNT(*)` or
        // created-at selector would accept it, while the shared lifecycle
        // loader must reject the exact phase proof.
        conn.execute(
            "UPDATE narrative_extraction_tasks
                SET task_kind = 'maintenance-dependency-verify'
              WHERE run_id = ?1",
            [BASELINE_REBUILD_RUN_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("forge wrong phase Task kind");

    let evidence = scheduler_heartbeat(&db, "c2zc-task-owner-authority", 1);
    db.with_conn(|conn| {
        let readiness = inspect_workspace_cutover_readiness_with_liveness(conn, Some(&evidence))?;
        assert!(!readiness.ready);
        assert_eq!(readiness.state, ReadinessState::Blocked);
        assert!(
            readiness
                .reasons
                .iter()
                .any(|reason| reason == "phase-lifecycle:phase-lifecycle-ownership-invalid:rebuild"),
            "unexpected readiness reasons: {:?}",
            readiness.reasons
        );

        let error = cut_over_workspace_freshness(conn, &evidence)
            .expect_err("wrong phase Task owner must block cutover");
        assert!(
            error
                .to_string()
                .contains("phase-lifecycle:phase-lifecycle-ownership-invalid:rebuild"),
            "unexpected cutover error: {error}"
        );
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 0, "blocked cutover must not write a marker");
        Ok::<_, anyhow::Error>(())
    })
    .expect("exact shared lifecycle owner must be required");
}

#[test]
fn canonical_read_has_no_legacy_fallback_after_generic_cutover() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();

    db.with_conn(|conn| {
        // The fixture deliberately calls the public cutover API only
        // after a test-owned durable fixture has satisfied the full contract.
        seed_cutover_ready_application(conn)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-test-authority", 1);
    db.with_conn(|conn| {
        let first = cut_over_workspace_freshness(conn, &evidence)?;
        let second = cut_over_workspace_freshness(conn, &evidence)?;
        assert_eq!(first, second, "cutover marker must be idempotent");

        conn.execute(
            "UPDATE narrative_projection_freshness
                SET status = 'source-missing'
              WHERE application_id = ?1",
            [APPLICATION_ID],
        )?;
        let read = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)?
            .expect("Generic Consumer Freshness row is the canonical read");
        assert_eq!(
            read.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(read.evidence_freshness, "fresh");
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("canonical read");
}

#[test]
fn canonical_read_fails_closed_when_generic_evidence_is_missing() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();

    db.with_conn(|conn| {
        seed_cutover_ready_application(conn)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-test-authority", 2);
    db.with_conn(|conn| {
        cut_over_workspace_freshness(conn, &evidence)?;
        conn.execute(
            "DELETE FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, APPLICATION_ID],
        )?;

        let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
            .expect_err("missing Generic evidence must not fall back to Legacy");
        assert!(error
            .to_string()
            .contains("NEX_C2ZC_GENERIC_FRESHNESS_MISSING"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("fail-closed canonical read");
}

#[test]
fn cutover_and_canonical_read_reject_idle_checkpoint_as_generic_publisher() {
    let _test_guard = serialize_liveness_test();

    // The fixture's normal publisher is the completed Rebuild lifecycle. A
    // scheduler-only idle checkpoint may prove current-Epoch liveness, but it
    // must never become the provenance of a Generic Consumer Freshness row.
    let db = fixture_db();
    db.with_conn(|conn| {
        seed_cutover_ready_application_with_freshness_state(
            conn,
            "fresh",
            "none",
            Some(BASELINE_FRESHNESS_RUN_ID),
        )
    })
    .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-idle-publisher-cutover", 4);
    db.with_conn(|conn| {
        let error = cut_over_workspace_freshness(conn, &evidence)
            .expect_err("cutover must reject an idle checkpoint as publisher provenance");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH"),
            "unexpected cutover error: {error}"
        );
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 0, "blocked cutover must not write a marker");
        Ok::<_, anyhow::Error>(())
    })
    .expect("reject idle publisher during cutover");

    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-idle-publisher-read", 5);
    db.with_conn(|conn| {
        cut_over_workspace_freshness(conn, &evidence)?;
        conn.execute(
            "UPDATE narrative_consumer_freshness
                SET last_evaluated_run_id = ?1
              WHERE project_id = ?2 AND consumer_kind = 'application'
                AND consumer_key = ?3",
            params![BASELINE_FRESHNESS_RUN_ID, PROJECT_ID, APPLICATION_ID],
        )?;
        let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
            .expect_err("canonical read must reject an idle checkpoint as publisher provenance");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH"),
            "unexpected canonical-read error: {error}"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("reject idle publisher during canonical read");
}

#[test]
fn cutover_and_canonical_read_accept_completed_current_epoch_rebuild_publisher() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    // The durable fixture seals Backfill -> Rebuild -> confirmation Verify
    // at increasing lifecycle instants. `scheduler_heartbeat` then executes
    // the real idle Incremental Freshness cycle before the public cutover.
    db.with_conn(|conn| {
        seed_cutover_ready_application_with_freshness_state(
            conn,
            "fresh",
            "none",
            Some(BASELINE_REBUILD_RUN_ID),
        )
    })
    .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-rebuild-publisher-authority", 3);

    db.with_conn(|conn| {
        cut_over_workspace_freshness(conn, &evidence)
            .expect("a production Rebuild is a canonical Freshness publisher");
        let canonical = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)?
            .expect("Rebuild-published Generic Freshness is canonical");
        assert_eq!(
            canonical.last_evaluated_run_id.as_deref(),
            Some(BASELINE_REBUILD_RUN_ID)
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("accept strict completed Rebuild publisher");
}

#[test]
fn canonical_read_rejects_non_incremental_or_stale_evaluation_run_reference() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed cutover fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-run-reference-authority", 3);
    db.with_conn(|conn| {
        cut_over_workspace_freshness(conn, &evidence)?;
        // This Run belongs to the project, but it is a completed Verify, not
        // a completed current-Epoch Freshness publisher.
        conn.execute(
            "UPDATE narrative_consumer_freshness
                SET last_evaluated_run_id = ?1
              WHERE project_id = ?2 AND consumer_kind = 'application'
                AND consumer_key = ?3",
            params![BASELINE_VERIFY_RUN_ID, PROJECT_ID, APPLICATION_ID],
        )?;
        let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
            .expect_err("foreign maintenance Run must not attest canonical Freshness");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH"),
            "unexpected error: {error}"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("fail closed invalid evaluation Run reference");
}

#[test]
fn canonical_read_rejects_rebuild_publisher_without_exact_maintenance_closure() {
    let _test_guard = serialize_liveness_test();
    for (index, mutation) in [
        "wrong-project",
        "wrong-epoch",
        "wrong-work-key",
        "missing-task",
        "missing-attempt",
        "wrong-task-kind",
        "wrong-attempt-status",
        "malformed-lifecycle-timestamp",
        "mismatched-terminal-instant",
    ]
    .into_iter()
    .enumerate()
    {
        let db = fixture_db();
        db.with_conn(seed_cutover_ready_application)
            .expect("seed cutover fixture");
        let evidence = scheduler_heartbeat(
            &db,
            &format!("c2zc-rebuild-publisher-negative-{index}"),
            (index + 30) as u64,
        );

        db.with_conn(|conn| {
            cut_over_workspace_freshness(conn, &evidence)?;
            conn.execute(
                "UPDATE narrative_consumer_freshness
                    SET last_evaluated_run_id = ?1
                  WHERE project_id = ?2 AND consumer_kind = 'application'
                    AND consumer_key = ?3",
                params![BASELINE_REBUILD_RUN_ID, PROJECT_ID, APPLICATION_ID],
            )?;

            match mutation {
                "wrong-project" => {
                    conn.execute(
                        "INSERT INTO projects (id, title) VALUES ('project-c2zc-other', 'Other')",
                        [],
                    )?;
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET project_id = 'project-c2zc-other'
                          WHERE id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "wrong-epoch" => {
                    conn.execute(
                        "UPDATE narrative_semantic_epochs
                            SET epoch_number = 1
                          WHERE id = ?1",
                        [EPOCH_ID],
                    )?;
                    conn.execute(
                        "INSERT INTO narrative_semantic_epochs
                            (id, project_id, epoch_number, reason, created_at)
                         VALUES ('epoch-c2zc-stale', ?1, 0, 'initial', ?2)",
                        params![PROJECT_ID, NOW],
                    )?;
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET semantic_epoch_id = 'epoch-c2zc-stale'
                          WHERE id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "wrong-work-key" => {
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET work_key = 'dependency-rebuild-forged'
                          WHERE id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "missing-task" => {
                    conn.execute(
                        "DELETE FROM narrative_extraction_attempts
                          WHERE task_id = ?1",
                        [format!("{BASELINE_REBUILD_RUN_ID}-task")],
                    )?;
                    conn.execute(
                        "DELETE FROM narrative_extraction_tasks WHERE run_id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "missing-attempt" => {
                    conn.execute(
                        "DELETE FROM narrative_extraction_attempts
                          WHERE task_id = ?1",
                        [format!("{BASELINE_REBUILD_RUN_ID}-task")],
                    )?;
                }
                "wrong-task-kind" => {
                    conn.execute(
                        "UPDATE narrative_extraction_tasks
                            SET task_kind = 'maintenance-dependency-verify'
                          WHERE run_id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "wrong-attempt-status" => {
                    conn.execute(
                        "UPDATE narrative_extraction_attempts
                            SET status = 'failed'
                          WHERE task_id = ?1",
                        [format!("{BASELINE_REBUILD_RUN_ID}-task")],
                    )?;
                }
                "malformed-lifecycle-timestamp" => {
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET created_at = 'not-an-instant'
                          WHERE id = ?1",
                        [BASELINE_REBUILD_RUN_ID],
                    )?;
                }
                "mismatched-terminal-instant" => {
                    conn.execute(
                        "UPDATE narrative_extraction_attempts
                            SET completed_at = '2026-08-24T00:00:00.006Z'
                          WHERE task_id = ?1",
                        [format!("{BASELINE_REBUILD_RUN_ID}-task")],
                    )?;
                }
                other => panic!("unknown mutation {other}"),
            }

            let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
                .expect_err("forged Rebuild closure must not attest canonical Freshness");
            assert!(
                error
                    .to_string()
                    .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_MISMATCH"),
                "unexpected error for {mutation}: {error}"
            );
            Ok::<_, anyhow::Error>(())
        })
        .unwrap_or_else(|error| panic!("reject forged Rebuild publisher {mutation}: {error}"));
    }
}

#[test]
fn cutover_rejects_evaluated_freshness_without_a_publisher_run() {
    let _test_guard = serialize_liveness_test();
    for (index, (freshness, build_action)) in [
        ("fresh", "none"),
        ("stale", "rebuild-required"),
        ("source-missing", "rebuild-required"),
    ]
    .into_iter()
    .enumerate()
    {
        let db = fixture_db();
        db.with_conn(|conn| {
            seed_cutover_ready_application_with_freshness_state(conn, freshness, build_action, None)
        })
        .expect("seed runless evaluated Generic state");
        let evidence = scheduler_heartbeat(
            &db,
            &format!("c2zc-runless-cutover-{index}"),
            (index + 10) as u64,
        );

        db.with_conn(|conn| {
            let error = cut_over_workspace_freshness(conn, &evidence).expect_err(
                "only the deliberate unknown/manual seed may omit its Freshness publisher Run",
            );
            assert!(
                error
                    .to_string()
                    .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_REQUIRED"),
                "unexpected {freshness}/{build_action} cutover error: {error}"
            );
            let marker_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
                [C2_ZC_CUTOVER_MIGRATION_ID],
                |row| row.get(0),
            )?;
            assert_eq!(marker_count, 0, "failed validation must not activate C2-ZC");
            Ok::<_, anyhow::Error>(())
        })
        .expect("reject runless evaluated freshness at cutover");
    }
}

#[test]
fn cutover_rejects_fabricated_clean_verify_after_live_derived_state_deletion() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed cutover-ready fixture");
    let evidence = scheduler_heartbeat(&db, "c2zc-live-verify-tamper-authority", 40);

    db.with_conn(|conn| {
        // Keep the Application's current state intact so the ordinary
        // cutover row validation cannot identify this mutation first. The
        // non-Application Revision Edge is still a production Verify input,
        // and deleting its derived state makes the live graph Rebuildable.
        conn.execute(
            "DELETE FROM narrative_dependency_edge_states
              WHERE edge_id = 'edge-revision-c2zc'",
            [],
        )?;
        let live_report = verify_narrative_dependency_graph_for_project(conn, PROJECT_ID)?;
        assert!(live_report.rebuild_required);
        assert_eq!(live_report.edge_ids_without_current_epoch_state.len(), 1);

        // Forge a clean-looking persisted Verify report after the graph was
        // changed. Every finding array and the rebuild decision are cleared,
        // while the two reserved Semantic Index checks retain exactly the
        // four all-zero observations required by the production contract.
        let mut fabricated_report = serde_json::to_value(live_report)?;
        let report_object = fabricated_report
            .as_object_mut()
            .expect("Verify report serializes as an object");
        for field in [
            "edgeIdsWithMissingSource",
            "duplicateEdgeKeys",
            "edgeIdsWithCrossProjectConsumer",
            "edgeIdsWithMalformedKeys",
            "edgeStateIdsOutsideCurrentEpoch",
            "edgeIdsWithoutCurrentEpochState",
            "findingObservationIdsOutsideCurrentEpoch",
            "consumerKeysWithoutCurrentEpochFreshness",
            "duplicateEdgeIdsToDeactivate",
            "edgeIdsWithUnresolvableConsumerScope",
            "consumerKeysWithStaleDependencySetDigest",
            "consumerKeysWithUncomputedDependencySetDigest",
            "orphanedAttentionFindingKeys",
            "orphanedAttentionRehomeAmbiguities",
        ] {
            report_object.insert(field.to_string(), json!([]));
        }
        report_object.insert("rebuildRequired".to_string(), json!(false));
        let reserved_counts = json!({
            "metadataRows": 0,
            "activeD1HeadRows": 0,
            "v1EdgeRows": 0,
            "consumerFreshnessRows": 0,
        });
        for field in [
            "applicationRevisionArtifactReferences",
            "semanticIndexDependencySetDigest",
            "contributionToApplicationCommitCorrespondence",
            "legacyMirrorMigrationParity",
            "cursorAndFeedHeadConsistency",
            "semanticIndexGenerationCorrespondence",
        ] {
            let check = report_object
                .get_mut(field)
                .and_then(Value::as_object_mut)
                .expect("Verify coverage check serializes as an object");
            check.insert("completed".to_string(), json!(true));
            check.insert("passed".to_string(), json!(true));
            check.insert("issues".to_string(), json!([]));
            check.insert("incomplete".to_string(), json!([]));
            if matches!(
                field,
                "semanticIndexDependencySetDigest" | "semanticIndexGenerationCorrespondence"
            ) {
                check.insert("observedCounts".to_string(), reserved_counts.clone());
            } else {
                check.remove("observedCounts");
            }
        }
        let fabricated_report: DependencyGraphVerifyReport =
            serde_json::from_value(fabricated_report)?;
        assert!(fabricated_report.is_clean());
        let fabricated_report = serde_json::to_value(fabricated_report)?;
        let report_digest = format!("sha256:{}", digest_plan(&fabricated_report));
        let graph_state_digest = durable_graph_state_digest(conn, PROJECT_ID)?;

        let mut outcome: Value = conn
            .query_row(
                "SELECT outcome_summary_json
               FROM narrative_extraction_runs
              WHERE id = ?1",
                [BASELINE_VERIFY_RUN_ID],
                |row| row.get::<_, String>(0),
            )?
            .parse()
            .expect("Verify outcome is valid JSON");
        outcome["semanticEpochId"] = json!(EPOCH_ID);
        outcome["verifyContractVersion"] = json!(VERIFY_RUN_KIND_CONTRACT_VERSION);
        outcome["reportDigest"] = json!(report_digest.clone());
        outcome["graphStateDigest"] = json!(graph_state_digest.clone());
        outcome["report"] = fabricated_report;
        outcome["checkCoverage"] = production_verify_check_coverage();
        outcome["outcomeDigest"] = json!(canonical_verify_outcome_digest(&outcome)?);
        outcome["skipEvidence"]["reportDigest"] = json!(report_digest);
        outcome["skipEvidence"]["graphStateDigest"] = json!(graph_state_digest);
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET outcome_summary_json = ?1
              WHERE id = ?2",
            params![outcome.to_string(), BASELINE_VERIFY_RUN_ID],
        )?;

        // The persisted report now has current graph/evidence digests and
        // exact 13/13 coverage, so the initial readiness inspection alone is
        // intentionally fooled. The cutover's same-transaction live Verify
        // guard must be the boundary that rejects the tamper.
        let readiness = inspect_workspace_cutover_readiness_with_liveness(conn, Some(&evidence))?;
        assert!(
            readiness.ready,
            "tampered persisted evidence should fool readiness only: {readiness:?}"
        );

        let error = cut_over_workspace_freshness(conn, &evidence)
            .expect_err("live Verify must reject fabricated clean evidence");
        assert!(
            error
                .to_string()
                .contains("NEX_C2ZC_CUTOVER_VERIFY_EVIDENCE_STALE"),
            "unexpected tampered Verify error: {error}"
        );
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            marker_count, 0,
            "stale Verify evidence must not activate C2-ZC"
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("reject fabricated clean Verify evidence at cutover");
}

#[test]
fn canonical_read_rejects_evaluated_freshness_without_a_publisher_run() {
    let _test_guard = serialize_liveness_test();
    for (index, (freshness, build_action)) in [
        ("fresh", "none"),
        ("stale", "rebuild-required"),
        ("source-missing", "rebuild-required"),
    ]
    .into_iter()
    .enumerate()
    {
        let db = fixture_db();
        db.with_conn(seed_cutover_ready_application)
            .expect("seed cutover fixture");
        let evidence = scheduler_heartbeat(
            &db,
            &format!("c2zc-runless-read-{index}"),
            (index + 20) as u64,
        );
        db.with_conn(|conn| {
            cut_over_workspace_freshness(conn, &evidence)?;
            conn.execute(
                "UPDATE narrative_consumer_freshness
                    SET evidence_freshness = ?1,
                        build_action = ?2,
                        last_evaluated_run_id = NULL
                  WHERE project_id = ?3 AND consumer_kind = 'application'
                    AND consumer_key = ?4",
                params![freshness, build_action, PROJECT_ID, APPLICATION_ID],
            )?;
            let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
                .expect_err("evaluated canonical Freshness must retain its Incremental Run");
            assert!(
                error
                    .to_string()
                    .contains("NEX_C2ZC_GENERIC_FRESHNESS_RUN_REQUIRED"),
                "unexpected {freshness}/{build_action} canonical-read error: {error}"
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("reject runless evaluated freshness on canonical read");
    }
}

fn seed_cutover_ready_application(conn: &Connection) -> anyhow::Result<()> {
    seed_cutover_ready_application_with_freshness_state(
        conn,
        "fresh",
        "none",
        Some(BASELINE_REBUILD_RUN_ID),
    )
}

fn seed_cutover_ready_application_with_freshness_state(
    conn: &Connection,
    evidence_freshness: &str,
    build_action: &str,
    last_evaluated_run_id: Option<&str>,
) -> anyhow::Result<()> {
    let backfill_spec = json!({ "backfillAlgorithmVersion": "3" });
    let backfill_spec_json = backfill_spec.to_string();
    let backfill_outcome = json!({
        "maintenancePhase": "backfill-complete",
        "backfillAlgorithmVersion": "3",
        "semanticEpochId": EPOCH_ID,
        "summary": {
            "epoch_created": false,
            "contributions_created": 0,
            "edges_created": 1,
            "applications_without_run_id": 0,
        },
    });
    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json, created_at, updated_at)
         VALUES ('set-c2zc', ?1, ?2, 'extraction', 'applied', '{}', ?3, ?3)",
        params![BASELINE_RUN_ID, PROJECT_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             created_at, updated_at)
         VALUES ('proposal-c2zc', 'set-c2zc', 'proposal-c2zc', 'codex-entry',
                 'approved', '{}', ?1, ?1)",
        params![NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, created_at, created_by)
         VALUES ('revision-c2zc', 'proposal-c2zc', 1, '{}', 'enveloped',
                 ?1, ?2, 'c2zc-fixture')",
        params![
            json!({
                "sourceBasis": [{
                    "sourceKind": "scene-body",
                    "sourceKey": SOURCE_IDENTITY,
                    "revisionToken": "token-c2zc",
                }]
            })
            .to_string(),
            NOW,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_revision_source_basis
            (revision_id, ordinal, source_kind, source_key, revision_token, observed_at)
         VALUES ('revision-c2zc', 0, 'scene-body', ?1, 'token-c2zc', ?2)",
        params![SOURCE_IDENTITY, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
             status, created_at)
         VALUES ('commit-c2zc', ?1, ?2, 'set-c2zc', 'request-c2zc', 'sha256:c2zc',
                 'committed', ?3)",
        params![PROJECT_ID, BASELINE_RUN_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, 'commit-c2zc', 'proposal-c2zc', 'revision-c2zc',
                 'codex-entry', 'entry-c2zc', ?2)",
        params![APPLICATION_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, started_at, completed_at, run_kind,
             semantic_epoch_id, work_key, outcome_summary_json)
         VALUES (?1, ?2, 'maintenance', '{}', ?3, ?4, 'completed',
                 '{}', ?5, ?6, ?7, 'backfill', ?8,
                 'legacy-dependency-backfill:v3', ?9)",
        params![
            BASELINE_RUN_ID,
            PROJECT_ID,
            &backfill_spec_json,
            format!("sha256:{}", digest_plan(&backfill_spec)),
            BACKFILL_CREATED_AT,
            BACKFILL_STARTED_AT,
            BACKFILL_AT,
            EPOCH_ID,
            backfill_outcome.to_string(),
        ],
    )?;
    seed_phase_lifecycle_closure(
        conn,
        BASELINE_RUN_ID,
        "maintenance-backfill",
        &backfill_spec_json,
        BACKFILL_CREATED_AT,
        BACKFILL_STARTED_AT,
        BACKFILL_AT,
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_freshness
            (application_id, status, reason_json, version, updated_at)
         VALUES (?1, ?2, NULL, 0, ?3)",
        params![APPLICATION_ID, evidence_freshness, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_dependencies
            (application_id, source_kind, source_key, observed_revision_token, propagation)
         VALUES (?1, 'scene-body', ?2, 'token-c2zc', 'freshness-only')",
        params![APPLICATION_ID, SOURCE_IDENTITY],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, 'application', ?2, ?3, ?4, ?5, ?6,
                 ?7, ?8)",
        params![
            PROJECT_ID,
            APPLICATION_ID,
            evidence_freshness,
            build_action,
            EPOCH_ID,
            last_evaluated_run_id,
            dependency_set_digest(&[SOURCE_IDENTITY]),
            NOW
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, created_at, owning_run_id)
         VALUES ('edge-c2zc', ?1, 'application', ?2, ?3,
                 '[\"token-c2zc\"]', ?4, ?5)",
        params![
            PROJECT_ID,
            APPLICATION_ID,
            SOURCE_IDENTITY,
            NOW,
            BASELINE_RUN_ID
        ],
    )?;

    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES ('edge-c2zc', ?1, ?2, NULL, ?3, ?4, ?5)",
        params![PROJECT_ID, evidence_freshness, build_action, EPOCH_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, created_at, owning_run_id)
         VALUES ('edge-revision-c2zc', ?1, 'proposal-revision', 'revision-c2zc', ?2,
                 '[\"token-c2zc\"]', ?3, ?4)",
        params![PROJECT_ID, SOURCE_IDENTITY, NOW, BASELINE_RUN_ID],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edge_states
            (edge_id, project_id, evidence_freshness, reason_code, build_action,
             evaluated_at_epoch_id, evaluated_at)
         VALUES ('edge-revision-c2zc', ?1, ?2, NULL, ?3, ?4, ?5)",
        params![PROJECT_ID, evidence_freshness, build_action, EPOCH_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, 'proposal-revision', 'revision-c2zc', ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            PROJECT_ID,
            evidence_freshness,
            build_action,
            EPOCH_ID,
            Some(BASELINE_REBUILD_RUN_ID),
            dependency_set_digest(&[SOURCE_IDENTITY]),
            NOW,
        ],
    )?;

    // Cursor and freshness rows are part of the Verify CAS graph snapshot.
    // A zero-width current-Epoch Run is only valid when it has the durable
    // idle-checkpoint producer shape: exact tagged Task input, matching Run
    // spec/work key digests, and the tagged zero-count outcome.  Keep the
    // fixture faithful to that production contract rather than using a
    // synthetic zero-width outcome that readiness must reject.
    let idle_payload = json!({
        "kind": "current-epoch-idle-checkpoint",
        "version": 1,
        "projectId": PROJECT_ID,
        "semanticEpochId": EPOCH_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 0,
        "feedHead": 0,
    });
    let idle_input_digest = format!("sha256:{}", digest_plan(&idle_payload));
    let idle_task_input = json!({
        "kind": "current-epoch-idle-checkpoint",
        "version": 1,
        "projectId": PROJECT_ID,
        "semanticEpochId": EPOCH_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 0,
        "feedHead": 0,
        "inputDigest": idle_input_digest,
    });
    let idle_spec = json!({
        "kind": "incremental-freshness-idle-checkpoint@1",
        "inputDigest": idle_input_digest,
    });
    let idle_spec_digest = format!("sha256:{}", digest_plan(&idle_spec));
    let idle_work_key = format!(
        "incremental-freshness:{EPOCH_ID}:0:0:{}",
        idle_input_digest.trim_start_matches("sha256:")
    );
    let incremental_outcome = json!({
        "kind": "current-epoch-idle-checkpoint",
        "version": 1,
        "projectId": PROJECT_ID,
        "runId": BASELINE_FRESHNESS_RUN_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 0,
        "affectedEdgeCount": 0,
        "affectedConsumerCount": 0,
        "hasMore": false,
    });
    conn.execute(
        "INSERT INTO narrative_change_cursors
            (project_id, consumer_id, acknowledged_through_sequence, updated_at)
         VALUES (?1, 'narrative-incremental-freshness/v1', 0, ?2)",
        params![PROJECT_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, completed_at,
             started_at, run_kind, semantic_epoch_id, work_key, consumer_id)
         VALUES (?1, ?2, 'maintenance', '{}', ?3, ?4, 'completed',
                 '{}', ?5, ?6, ?7, ?8, 'freshness-evaluation', ?9, ?10,
                 'narrative-incremental-freshness/v1')",
        params![
            BASELINE_FRESHNESS_RUN_ID,
            PROJECT_ID,
            &idle_spec.to_string(),
            idle_spec_digest,
            incremental_outcome.to_string(),
            NOW,
            NOW,
            NOW,
            EPOCH_ID,
            idle_work_key,
        ],
    )?;
    seed_phase_lifecycle_closure(
        conn,
        BASELINE_FRESHNESS_RUN_ID,
        "incremental-freshness-batch",
        &idle_task_input.to_string(),
        NOW,
        NOW,
        NOW,
    )?;

    // The sealed Verify evidence must be the live graph's own report: the
    // cutover now runs the same skip-evidence CAS an ordinary maintenance
    // wake uses, so fabricated default-report JSON no longer passes.
    let live_report = verify_narrative_dependency_graph_for_project(conn, PROJECT_ID)?;
    anyhow::ensure!(
        live_report.is_clean(),
        "fixture graph must verify clean: {live_report:?}"
    );
    let report = serde_json::to_value(&live_report)?;
    let verify_spec = json!({ "verifyContractVersion": VERIFY_RUN_KIND_CONTRACT_VERSION });
    let verify_spec_json = verify_spec.to_string();
    let graph_state_digest = durable_graph_state_digest(conn, PROJECT_ID)?;
    let mut verify_outcome = json!({
        "verifyContractVersion": VERIFY_RUN_KIND_CONTRACT_VERSION,
        "semanticEpochId": EPOCH_ID,
        "graphStateDigest": graph_state_digest.clone(),
        "reportDigest": format!("sha256:{}", digest_plan(&report)),
        "report": report,
        "checkCoverage": production_verify_check_coverage(),
    });
    verify_outcome["outcomeDigest"] = json!(canonical_verify_outcome_digest(&verify_outcome)?);
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, started_at,
             completed_at, run_kind, semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', ?3, ?4, 'completed',
                 '{}', ?5, ?6, ?7, ?8, 'dependency-verify', ?9, ?10)",
        params![
            BASELINE_VERIFY_RUN_ID,
            PROJECT_ID,
            &verify_spec_json,
            format!("sha256:{}", digest_plan(&verify_spec)),
            verify_outcome.to_string(),
            VERIFY_CREATED_AT,
            VERIFY_STARTED_AT,
            VERIFY_AT,
            EPOCH_ID,
            format!("{VERIFY_WORK_KEY_PREFIX}{EPOCH_ID}")
        ],
    )?;
    seed_phase_lifecycle_closure(
        conn,
        BASELINE_VERIFY_RUN_ID,
        "maintenance-dependency-verify",
        &verify_spec_json,
        VERIFY_CREATED_AT,
        VERIFY_STARTED_AT,
        VERIFY_AT,
    )?;
    let coordinates = current_maintenance_coordinates()?;
    let evidence = CompletedRunSkipEvidence {
        project_id: PROJECT_ID.to_string(),
        run_kind: "dependency-verify".to_string(),
        work_key: format!("{VERIFY_WORK_KEY_PREFIX}{EPOCH_ID}"),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: coordinates.graph_contract_digest,
        rule_registry_digest: coordinates.rule_registry_digest,
        producer_generation_set_digest: coordinates.producer_generation_set_digest,
        rebuild_contract_version: "1".to_string(),
        run_kind_contract_version: VERIFY_RUN_KIND_CONTRACT_VERSION.to_string(),
        report_digest: format!("sha256:{}", digest_plan(&report)),
        graph_state_digest,
    };
    conn.execute_batch("SAVEPOINT seed_skip_evidence")?;
    persist_completed_run_skip_evidence_in_tx(conn, BASELINE_VERIFY_RUN_ID, &evidence)?;
    conn.execute_batch("RELEASE seed_skip_evidence")?;

    let summary = json!({
        "consumersEvaluated": 2,
        "edgesEvaluated": 2,
        "consumersSkippedUnresolvableScope": 0,
        "edgesSkippedUnresolvableScope": 0,
    });
    let rebuild_spec = json!({});
    let rebuild_spec_json = rebuild_spec.to_string();
    let rebuild_outcome = json!({
        "rebuildContractVersion": "1",
        "semanticEpochId": EPOCH_ID,
        "summaryDigest": format!("sha256:{}", digest_plan(&summary)),
        "summary": summary,
    });
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, started_at,
             completed_at, run_kind, semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', ?3, ?4, 'completed',
                 '{}', ?5, ?6, ?7, ?8, 'semantic-index-rebuild', ?9, ?10)",
        params![
            BASELINE_REBUILD_RUN_ID,
            PROJECT_ID,
            &rebuild_spec_json,
            format!("sha256:{}", digest_plan(&rebuild_spec)),
            rebuild_outcome.to_string(),
            REBUILD_CREATED_AT,
            REBUILD_STARTED_AT,
            REBUILD_AT,
            EPOCH_ID,
            REBUILD_DERIVED_WORK_KEY
        ],
    )?;
    seed_phase_lifecycle_closure(
        conn,
        BASELINE_REBUILD_RUN_ID,
        "maintenance-semantic-index-rebuild",
        &rebuild_spec_json,
        REBUILD_CREATED_AT,
        REBUILD_STARTED_AT,
        REBUILD_AT,
    )?;

    Ok(())
}

/// The maintenance lifecycle contract behind each phase Run: exactly one
/// completed Task and Attempt, terminalized with the Run.
fn seed_phase_lifecycle_closure(
    conn: &Connection,
    run_id: &str,
    task_kind: &str,
    spec_json: &str,
    created_at: &str,
    started_at: &str,
    completed_at: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, attempt_count,
             created_at, started_at, completed_at)
         VALUES (?1, ?2, ?3, 'completed', ?4, 1, ?5, ?6, ?7)",
        params![
            format!("{run_id}-task"),
            run_id,
            task_kind,
            spec_json,
            created_at,
            started_at,
            completed_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at, completed_at)
         VALUES (?1, ?2, 1, 'completed', ?3, ?4)",
        params![
            format!("{run_id}-attempt"),
            format!("{run_id}-task"),
            started_at,
            completed_at,
        ],
    )?;
    Ok(())
}

fn dependency_set_digest(source_identities: &[&str]) -> String {
    let mut values = source_identities
        .iter()
        .map(|identity| (*identity).to_string())
        .collect::<Vec<_>>();
    values.sort();
    let canonical = values
        .iter()
        .map(|identity| format!("{}:{}\n", identity.len(), identity))
        .collect::<String>();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

fn consumer_freshness_row(db: &Database, consumer_id: &str) -> ConsumerFreshnessRow {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT project_id, consumer_kind, consumer_key, evidence_freshness,
                    build_action, semantic_epoch_id, last_evaluated_run_id,
                    dependency_set_digest, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, consumer_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )?)
    })
    .expect("read complete Generic Consumer Freshness row")
}

fn application_edge_freshness_row(db: &Database, application_id: &str) -> EdgeFreshnessRow {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT s.edge_id, s.evidence_freshness, s.reason_code, s.build_action,
                    s.evaluated_at_epoch_id, s.evaluated_at
               FROM narrative_dependency_edge_states s
               JOIN narrative_dependency_edges e ON e.id = s.edge_id
              WHERE e.project_id = ?1 AND e.consumer_kind = 'application'
                AND e.consumer_key = ?2
              ORDER BY e.source_object_identity, e.id
              LIMIT 1",
            params![PROJECT_ID, application_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )?)
    })
    .expect("read complete Generic Edge State row")
}

fn mutate_scene_source(db: &Database) {
    let result = save_scene_body_bundle(
        db,
        SaveSceneBodyBundlePayload {
            scene_id: "scene-c2zc".to_string(),
            project_id: PROJECT_ID.to_string(),
            request_id: "request-c2zc-source-update".to_string(),
            session_id: "session-c2zc-source-update".to_string(),
            event_uid: "event-c2zc-source-update".to_string(),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            include_sidecars: false,
            base_version: Some(0),
            updated_at: "2026-08-24T00:00:01.000Z".to_string(),
            content_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"source update"}]}]}"#.to_string(),
            char_count: 12,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_string(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: std::collections::HashMap::new(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 12,
        },
    )
    .expect("mutate exact Source through the typed scene writer");
    assert_eq!(result.content_version, 1);
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("load runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".to_string(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("enable manual apply");
}

fn enable_manual_apply_preserving_flags(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("load runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".to_string(),
            maintenance_enabled: before.maintenance_enabled,
            generic_import_enabled: before.generic_import_enabled,
            background_ai_enabled: before.background_ai_enabled,
        },
    )
    .expect("enable manual apply without changing other policy flags");
}

fn prepared_event_payload_for(event_id: &str, scene_id: &str, title: &str) -> Value {
    json!({
        "eventId": event_id,
        "title": title,
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": scene_id,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none"
    })
}

fn prepared_event_payload() -> Value {
    prepared_event_payload_for("event-c2zc-prepared", "scene-c2zc", "C2-ZC prepared event")
}

fn prepared_envelope_for(
    source_identity: &str,
    revision_token: &str,
    run_id: &str,
    task_id: &str,
) -> Value {
    let read_set = json!([{
        "inputRef": source_identity,
        "kind": "snapshot-document",
        "sourceKind": "scene-body",
        "revisionToken": revision_token,
    }]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "test.c2zc.prepared",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "chronicle.event",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "scene-body",
            "sourceKey": source_identity,
            "revisionToken": revision_token,
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn prepared_envelope(run_id: &str, task_id: &str) -> Value {
    prepared_envelope_for(SOURCE_IDENTITY, &format!("v0@{NOW}"), run_id, task_id)
}

type LegacySnapshotScopeKind = release_schema_fixture::LegacySeedScope;
type LegacySnapshotTable = release_schema_fixture::LegacySeedTable;

#[derive(Debug)]
struct LegacySnapshotIdentity {
    project_ids: BTreeSet<String>,
    chat_session_project_by_id: BTreeMap<String, String>,
    scene_project_by_id: BTreeMap<String, String>,
    event_project_by_id: BTreeMap<String, String>,
    fts_source_rowids: BTreeMap<&'static str, BTreeSet<i64>>,
}

#[derive(Debug)]
struct LegacySnapshotTableBaseline {
    descriptor: LegacySnapshotTable,
    projection_columns: Vec<String>,
    expected_rows: Vec<Vec<SqlValue>>,
    expected_keys: Vec<Vec<SqlValue>>,
}

#[derive(Debug)]
struct LegacySnapshotBaseline {
    expected_project_ids: BTreeSet<String>,
    tables: Vec<LegacySnapshotTableBaseline>,
}

fn quote_sql_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn snapshot_table_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<String>> {
    let sql = format!("PRAGMA table_info({})", quote_sql_identifier(table));
    let mut statement = conn.prepare(&sql)?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(columns)
}

fn snapshot_projection_columns(columns: &[String], include_rowid: bool) -> Vec<String> {
    if include_rowid {
        std::iter::once("rowid".to_string())
            .chain(columns.iter().cloned())
            .collect()
    } else {
        columns.to_vec()
    }
}

fn snapshot_rows(
    conn: &Connection,
    table: &str,
    columns: &[String],
    include_rowid: bool,
    order_by: &str,
) -> anyhow::Result<Vec<Vec<SqlValue>>> {
    anyhow::ensure!(
        !columns.is_empty(),
        "legacy snapshot table {table} has no columns"
    );
    let projection_columns = snapshot_projection_columns(columns, include_rowid);
    let projection = projection_columns
        .iter()
        .map(|column| {
            if column == "rowid" {
                "rowid".to_string()
            } else {
                quote_sql_identifier(column)
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {projection} FROM {} ORDER BY {order_by}",
        quote_sql_identifier(table)
    );
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map([], |row| {
            (0..projection_columns.len())
                .map(|index| row.get::<_, SqlValue>(index))
                .collect::<rusqlite::Result<Vec<_>>>()
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn snapshot_row_text<'a>(row: &'a [SqlValue], columns: &[String], column: &str) -> Option<&'a str> {
    let index = columns.iter().position(|name| name == column)?;
    match row.get(index)? {
        SqlValue::Text(value) => Some(value.as_str()),
        _ => None,
    }
}

fn snapshot_row_i64(row: &[SqlValue], columns: &[String], column: &str) -> Option<i64> {
    let index = columns.iter().position(|name| name == column)?;
    match row.get(index)? {
        SqlValue::Integer(value) => Some(*value),
        _ => None,
    }
}

fn snapshot_row_key(
    row: &[SqlValue],
    columns: &[String],
    identity_columns: &[&str],
) -> anyhow::Result<Vec<SqlValue>> {
    identity_columns
        .iter()
        .map(|column| {
            let index = columns
                .iter()
                .position(|name| name == column)
                .ok_or_else(|| anyhow::anyhow!("identity column {column} is not projected"))?;
            let value = row
                .get(index)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("identity column {column} is missing from row"))?;
            anyhow::ensure!(
                !matches!(value, SqlValue::Null),
                "identity column {column} must not be NULL"
            );
            Ok(value)
        })
        .collect()
}

fn expected_legacy_project_ids() -> BTreeSet<String> {
    release_schema_fixture::LEGACY_PROJECT_IDS
        .iter()
        .map(|project_id| (*project_id).to_string())
        .collect()
}

fn expected_legacy_setting_keys() -> BTreeSet<String> {
    [
        release_schema_fixture::RELEASE_FIXTURE_SETTING_KEY,
        release_schema_fixture::SECOND_RELEASE_FIXTURE_SETTING_KEY,
        release_schema_fixture::WAL_ONLY_SETTING_KEY,
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn read_identity_map(
    conn: &Connection,
    sql: &str,
    expected_project_ids: &BTreeSet<String>,
) -> anyhow::Result<BTreeMap<String, String>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, project_id)| expected_project_ids.contains(project_id))
        .collect())
}

fn read_fts_source_rowids(
    conn: &Connection,
    source_table: &'static str,
    expected_project_ids: &BTreeSet<String>,
) -> anyhow::Result<BTreeSet<i64>> {
    let sql = match source_table {
        "codex_entries" | "snippets" | "tree_nodes" => {
            format!(
                "SELECT rowid, project_id FROM {}",
                quote_sql_identifier(source_table)
            )
        }
        "chat_messages" => "SELECT messages.rowid, sessions.project_id
               FROM chat_messages messages
               JOIN chat_sessions sessions ON sessions.id = messages.session_id"
            .to_string(),
        other => anyhow::bail!("unsupported FTS source table {other}"),
    };
    let mut statement = conn.prepare(&sql)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter(|(_, project_id)| expected_project_ids.contains(project_id))
        .map(|(rowid, _)| rowid)
        .collect())
}

fn load_legacy_snapshot_identity(
    conn: &Connection,
    expected_project_ids: &BTreeSet<String>,
) -> anyhow::Result<LegacySnapshotIdentity> {
    let project_ids = conn
        .prepare("SELECT id FROM projects ORDER BY id")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    let chat_session_project_by_id = read_identity_map(
        conn,
        "SELECT id, project_id FROM chat_sessions",
        expected_project_ids,
    )?;
    let scene_project_by_id = read_identity_map(
        conn,
        "SELECT id, project_id FROM tree_nodes",
        expected_project_ids,
    )?;
    let event_project_by_id = read_identity_map(
        conn,
        "SELECT id, project_id FROM events",
        expected_project_ids,
    )?;
    let mut fts_source_rowids = BTreeMap::new();
    for source_table in ["codex_entries", "snippets", "chat_messages", "tree_nodes"] {
        fts_source_rowids.insert(
            source_table,
            read_fts_source_rowids(conn, source_table, expected_project_ids)?,
        );
    }
    Ok(LegacySnapshotIdentity {
        project_ids,
        chat_session_project_by_id,
        scene_project_by_id,
        event_project_by_id,
        fts_source_rowids,
    })
}

fn legacy_snapshot_row_is_in_scope(
    descriptor: LegacySnapshotTable,
    row: &[SqlValue],
    columns: &[String],
    identity: &LegacySnapshotIdentity,
) -> bool {
    match descriptor.scope {
        LegacySnapshotScopeKind::ProjectIdentity => snapshot_row_text(row, columns, "id")
            .is_some_and(|project_id| identity.project_ids.contains(project_id)),
        LegacySnapshotScopeKind::ProjectId => snapshot_row_text(row, columns, "project_id")
            .is_some_and(|project_id| identity.project_ids.contains(project_id)),
        LegacySnapshotScopeKind::SceneEventIdentity => {
            let scene_project = snapshot_row_text(row, columns, "scene_id")
                .and_then(|scene_id| identity.scene_project_by_id.get(scene_id));
            let event_project = snapshot_row_text(row, columns, "event_id")
                .and_then(|event_id| identity.event_project_by_id.get(event_id));
            scene_project.is_some() && scene_project == event_project
        }
        LegacySnapshotScopeKind::ChatSessionIdentity => {
            snapshot_row_text(row, columns, "session_id")
                .and_then(|session_id| identity.chat_session_project_by_id.get(session_id))
                .is_some()
        }
        LegacySnapshotScopeKind::FtsSource { source_table } => {
            snapshot_row_i64(row, columns, "rowid").is_some_and(|rowid| {
                identity
                    .fts_source_rowids
                    .get(source_table)
                    .is_some_and(|rowids| rowids.contains(&rowid))
            })
        }
        LegacySnapshotScopeKind::AuditProject => {
            let project_id = snapshot_row_text(row, columns, "project_id");
            let scope_id = snapshot_row_text(row, columns, "scope_id");
            project_id.is_some_and(|project_id| {
                identity.project_ids.contains(project_id)
                    && scope_id == Some(format!("project:{project_id}").as_str())
            })
        }
        LegacySnapshotScopeKind::AppSettingKey => snapshot_row_text(row, columns, "key")
            .is_some_and(|key| expected_legacy_setting_keys().contains(key)),
    }
}

fn load_legacy_snapshot_baseline(snapshot_path: &Path) -> anyhow::Result<LegacySnapshotBaseline> {
    let expected = Connection::open(snapshot_path)?;
    let expected_project_ids = expected_legacy_project_ids();
    let expected_identity = load_legacy_snapshot_identity(&expected, &expected_project_ids)?;
    anyhow::ensure!(
        expected_identity.project_ids == expected_project_ids,
        "the immutable release snapshot must contain exactly the expected project IDs"
    );

    let manifest_names = release_schema_fixture::LEGACY_SEED_TABLES
        .iter()
        .map(|descriptor| descriptor.table)
        .collect::<BTreeSet<_>>();
    anyhow::ensure!(
        manifest_names.len() == release_schema_fixture::LEGACY_SEED_TABLES.len(),
        "release fixture manifest must not contain duplicate table descriptors"
    );

    let mut tables = Vec::with_capacity(release_schema_fixture::LEGACY_SEED_TABLES.len());
    for descriptor in release_schema_fixture::LEGACY_SEED_TABLES {
        let expected_columns = snapshot_table_columns(&expected, descriptor.table)?;
        anyhow::ensure!(
            !expected_columns.is_empty(),
            "release snapshot is missing manifest table {}",
            descriptor.table
        );
        let include_rowid = matches!(descriptor.scope, LegacySnapshotScopeKind::FtsSource { .. });
        let projection_columns = snapshot_projection_columns(&expected_columns, include_rowid);
        let all_rows = snapshot_rows(
            &expected,
            descriptor.table,
            &expected_columns,
            include_rowid,
            descriptor.order_by,
        )?;
        let expected_rows = all_rows
            .into_iter()
            .filter(|row| {
                legacy_snapshot_row_is_in_scope(
                    *descriptor,
                    row,
                    &projection_columns,
                    &expected_identity,
                )
            })
            .collect::<Vec<_>>();
        anyhow::ensure!(
            !expected_rows.is_empty(),
            "manifest table {} must cover at least one seeded row in the immutable snapshot",
            descriptor.table
        );
        let expected_keys = expected_rows
            .iter()
            .map(|row| snapshot_row_key(row, &projection_columns, descriptor.identity_columns))
            .collect::<anyhow::Result<Vec<_>>>()?;
        anyhow::ensure!(
            expected_keys.len() == expected_rows.len(),
            "manifest table {} has incomplete seeded identity coverage",
            descriptor.table
        );
        tables.push(LegacySnapshotTableBaseline {
            descriptor: *descriptor,
            projection_columns,
            expected_rows,
            expected_keys,
        });
    }

    let baseline_names = tables
        .iter()
        .map(|table| table.descriptor.table)
        .collect::<BTreeSet<_>>();
    anyhow::ensure!(
        baseline_names == manifest_names,
        "immutable snapshot coverage must equal the exported release fixture manifest"
    );
    let baseline = LegacySnapshotBaseline {
        expected_project_ids,
        tables,
    };
    baseline.assert_fts_token_manifest()?;
    Ok(baseline)
}

impl LegacySnapshotBaseline {
    fn table(&self, table: &str) -> &LegacySnapshotTableBaseline {
        self.tables
            .iter()
            .find(|candidate| candidate.descriptor.table == table)
            .unwrap_or_else(|| panic!("release fixture manifest missing table {table}"))
    }

    fn expected_source_ids(&self, source_table: &str) -> BTreeSet<String> {
        self.table(source_table)
            .expected_keys
            .iter()
            .filter_map(|key| match key.first() {
                Some(SqlValue::Text(value)) => Some(value.clone()),
                _ => None,
            })
            .collect()
    }

    fn assert_fts_token_manifest(&self) -> anyhow::Result<()> {
        let mut expected_by_surface = BTreeMap::<&str, (&str, BTreeSet<String>)>::new();
        let mut actual_by_surface = BTreeMap::<&str, BTreeSet<String>>::new();
        for descriptor in &self.tables {
            if let LegacySnapshotScopeKind::FtsSource { source_table } = descriptor.descriptor.scope
            {
                expected_by_surface.insert(
                    descriptor.descriptor.table,
                    (source_table, self.expected_source_ids(source_table)),
                );
            }
        }
        for check in release_schema_fixture::LEGACY_FTS_TOKEN_CHECKS {
            anyhow::ensure!(
                expected_by_surface.contains_key(check.surface_table),
                "FTS token descriptor references unknown surface {}",
                check.surface_table
            );
            anyhow::ensure!(
                expected_by_surface
                    .get(check.surface_table)
                    .is_some_and(|(source_table, _)| *source_table == check.source_table),
                "FTS token descriptor maps {} to {}, but the manifest maps it to its declared source",
                check.surface_table,
                check.source_table
            );
            anyhow::ensure!(
                self.tables
                    .iter()
                    .any(|descriptor| descriptor.descriptor.table == check.source_table),
                "FTS token descriptor references unknown source {}",
                check.source_table
            );
            anyhow::ensure!(
                self.expected_source_ids(check.source_table)
                    .contains(check.source_id),
                "FTS token {} references non-seeded {} row {}",
                check.token,
                check.source_table,
                check.source_id
            );
            let inserted = actual_by_surface
                .entry(check.surface_table)
                .or_default()
                .insert(check.source_id.to_string());
            anyhow::ensure!(
                inserted,
                "FTS token manifest duplicates {}:{}",
                check.surface_table,
                check.source_id
            );
        }
        anyhow::ensure!(
            actual_by_surface
                == expected_by_surface
                    .into_iter()
                    .map(|(surface, (_, source_ids))| (surface, source_ids))
                    .collect(),
            "FTS token manifest must cover every seeded source row on every surface"
        );
        Ok(())
    }

    fn assert_fts_tokens_on_connection(&self, conn: &Connection) -> anyhow::Result<()> {
        for surface in self.tables.iter().filter_map(|descriptor| {
            descriptor
                .descriptor
                .scope
                .into_fts_source()
                .map(|_| descriptor.descriptor.table)
        }) {
            let surface_identifier = quote_sql_identifier(surface);
            let sql = format!(
                "INSERT INTO {surface_identifier}({surface_identifier}, rank) VALUES('integrity-check', 1)"
            );
            conn.execute(&sql, []).map_err(|error| {
                anyhow::anyhow!("FTS integrity-check failed for {surface}: {error}")
            })?;
        }
        for check in release_schema_fixture::LEGACY_FTS_TOKEN_CHECKS {
            let source_sql = format!(
                "SELECT rowid FROM {} WHERE id = ?1",
                quote_sql_identifier(check.source_table)
            );
            let source_rowid: i64 = conn
                .query_row(&source_sql, [check.source_id], |row| row.get(0))
                .map_err(|error| {
                    anyhow::anyhow!(
                        "seeded FTS source row {}:{} is missing: {error}",
                        check.source_table,
                        check.source_id
                    )
                })?;
            let surface_identifier = quote_sql_identifier(check.surface_table);
            let match_sql = format!(
                "SELECT rowid FROM {surface_identifier} WHERE {surface_identifier} MATCH ?1"
            );
            let mut statement = conn.prepare(&match_sql)?;
            let matched = statement
                .query_map([check.token], |row| row.get::<_, i64>(0))?
                .collect::<rusqlite::Result<BTreeSet<_>>>()?;
            let expected = BTreeSet::from([source_rowid]);
            anyhow::ensure!(
                matched == expected,
                "FTS MATCH {}:{} must return exactly source rowid {source_rowid}, got {matched:?}",
                check.surface_table,
                check.token
            );
        }
        Ok(())
    }

    fn assert_database(&self, db_path: &Path) -> bool {
        let actual = Connection::open(db_path).expect("open database for legacy snapshot check");
        let actual_project_ids = actual
            .prepare("SELECT id FROM projects ORDER BY id")
            .expect("prepare actual project identity query")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("read actual project identities")
            .collect::<rusqlite::Result<BTreeSet<_>>>()
            .expect("collect actual project identities");
        assert_eq!(
            actual_project_ids, self.expected_project_ids,
            "migrated database must retain exactly the two intended project identities"
        );

        for baseline in &self.tables {
            let descriptor = baseline.descriptor;
            let actual_columns =
                snapshot_table_columns(&actual, descriptor.table).unwrap_or_else(|error| {
                    panic!("read migrated {} columns: {error:#}", descriptor.table)
                });
            let expected_columns = baseline
                .projection_columns
                .iter()
                .filter(|column| column.as_str() != "rowid")
                .cloned()
                .collect::<Vec<_>>();
            let actual_legacy_columns = actual_columns
                .iter()
                .filter(|column| expected_columns.contains(column))
                .cloned()
                .collect::<Vec<_>>();
            assert_eq!(
                actual_legacy_columns, expected_columns,
                "migrated {} must retain every legacy column in order",
                descriptor.table
            );
            let include_rowid =
                matches!(descriptor.scope, LegacySnapshotScopeKind::FtsSource { .. });
            let actual_rows = snapshot_rows(
                &actual,
                descriptor.table,
                &expected_columns,
                include_rowid,
                descriptor.order_by,
            )
            .unwrap_or_else(|error| panic!("read migrated {} rows: {error:#}", descriptor.table));
            let actual_in_scope = actual_rows
                .into_iter()
                .filter(|row| {
                    snapshot_row_key(
                        row,
                        &baseline.projection_columns,
                        descriptor.identity_columns,
                    )
                    .ok()
                    .is_some_and(|key| {
                        baseline
                            .expected_keys
                            .iter()
                            .any(|expected| *expected == key)
                    })
                })
                .collect::<Vec<_>>();
            assert_eq!(
                actual_in_scope.len(),
                baseline.expected_rows.len(),
                "migrated {} has missing or changed seeded identities",
                descriptor.table
            );
            assert_eq!(
                actual_in_scope, baseline.expected_rows,
                "migrated {} seeded legacy rows differ in columns, values, identity, or order",
                descriptor.table
            );
        }
        self.assert_fts_tokens_on_connection(&actual)
            .unwrap_or_else(|error| panic!("verify seeded FTS tokens: {error:#}"));
        true
    }
}

impl LegacySnapshotScopeKind {
    fn into_fts_source(self) -> Option<&'static str> {
        match self {
            Self::FtsSource { source_table } => Some(source_table),
            _ => None,
        }
    }
}

/// Compare every legacy column and row from the supervisor's immutable
/// pre-migration image. Current-schema-only columns are intentionally not
/// part of the legacy claim, but every old table column, value, and canonical
/// row order must survive exactly; missing or changed rows for a seeded identity
/// fail the acceptance while legitimate post-migration runtime rows remain out
/// of scope.
fn assert_exact_legacy_user_snapshot(db_path: &Path, snapshot_path: &Path) -> bool {
    load_legacy_snapshot_baseline(snapshot_path)
        .unwrap_or_else(|error| panic!("load immutable release snapshot contract: {error:#}"))
        .assert_database(db_path)
}

fn clone_sqlite_image(source_path: &Path, destination_path: &Path) {
    let source = Connection::open(source_path).expect("open source SQLite image");
    source
        .execute(
            "VACUUM INTO ?1",
            [destination_path.to_string_lossy().as_ref()],
        )
        .expect("clone SQLite image for snapshot mutation");
}

fn assert_snapshot_rejects_mutation<F>(label: &str, mutate: F)
where
    F: FnOnce(&Connection) -> anyhow::Result<()>,
{
    let workspace = release_schema_fixture::temp_workspace(&format!("snapshot-red-{label}"));
    let db_path = release_schema_fixture::seed_previous_release_workspace(&workspace);
    let outcome = migration_supervisor::open_or_migrate_workspace_db(&workspace)
        .expect("previous-release fixture must migrate for snapshot mutation");
    let opened = match outcome {
        WorkspaceOpenDbOutcome::Migrated { opened, .. } => opened,
        other => panic!("expected migrated fixture for snapshot mutation, got {other:?}"),
    };
    drop(opened.database);
    drop(opened.lease);
    let snapshot_path = release_schema_fixture::latest_migration_snapshot(&workspace);
    let mutated_path = workspace.join(format!("snapshot-red-{label}.db"));
    clone_sqlite_image(&db_path, &mutated_path);
    {
        let conn = Connection::open(&mutated_path).expect("open mutable snapshot copy");
        mutate(&conn).unwrap_or_else(|error| panic!("apply {label} snapshot mutation: {error:#}"));
    }
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert_exact_legacy_user_snapshot(&mutated_path, &snapshot_path)
    }));
    assert!(
        result.is_err(),
        "legacy snapshot validator must reject {label} corruption"
    );
}

#[test]
fn legacy_snapshot_rejects_scene_event_and_each_fts_rowid_corruption() {
    let _test_guard = serialize_liveness_test();
    assert_snapshot_rejects_mutation("scene-events-delete", |conn| {
        conn.execute(
            "DELETE FROM scene_events
              WHERE scene_id = 'default-project-scene'
                AND event_id = 'default-project-event'",
            [],
        )?;
        Ok(())
    });
    for (label, sql) in [
        (
            "codex-fts-rowid-offset",
            "UPDATE codex_entries SET rowid = rowid + 1000 WHERE project_id = 'default-project'",
        ),
        (
            "snippets-fts-rowid-offset",
            "UPDATE snippets SET rowid = rowid + 1000 WHERE project_id = 'default-project'",
        ),
        (
            "chat-messages-fts-rowid-offset",
            "UPDATE chat_messages SET rowid = rowid + 1000 WHERE session_id = 'default-project-session'",
        ),
        (
            "tree-nodes-fts-rowid-offset",
            "UPDATE tree_nodes SET rowid = rowid + 1000 WHERE project_id = 'default-project'",
        ),
    ] {
        assert_snapshot_rejects_mutation(label, |conn| {
            conn.execute(sql, [])?;
            Ok(())
        });
    }
}

#[test]
fn legacy_snapshot_rejects_fts_index_delete_all_corruption() {
    let _test_guard = serialize_liveness_test();
    for table in [
        "codex_fts",
        "snippets_fts",
        "chat_messages_fts",
        "tree_nodes_fts",
    ] {
        assert_snapshot_rejects_mutation(&format!("{table}-delete-all"), |conn| {
            let sql = format!("INSERT INTO {table}({table}) VALUES('delete-all')");
            conn.execute(&sql, [])?;
            Ok(())
        });
    }
}

fn replace_fts_index_with_only_manifest_tokens(
    conn: &Connection,
    surface: &str,
) -> anyhow::Result<()> {
    let surface_identifier = quote_sql_identifier(surface);
    let delete_all_sql =
        format!("INSERT INTO {surface_identifier}({surface_identifier}) VALUES('delete-all')");
    conn.execute(&delete_all_sql, [])?;

    for check in release_schema_fixture::LEGACY_FTS_TOKEN_CHECKS
        .iter()
        .filter(|check| check.surface_table == surface)
    {
        let source_sql = format!(
            "SELECT rowid FROM {} WHERE id = ?1",
            quote_sql_identifier(check.source_table)
        );
        let source_rowid: i64 = conn.query_row(&source_sql, [check.source_id], |row| row.get(0))?;
        let insert_sql = match surface {
            "codex_fts" => {
                format!("INSERT INTO {surface_identifier}(rowid, aliases) VALUES (?1, ?2)")
            }
            "snippets_fts" => {
                format!("INSERT INTO {surface_identifier}(rowid, title) VALUES (?1, ?2)")
            }
            "chat_messages_fts" => {
                format!("INSERT INTO {surface_identifier}(rowid, content) VALUES (?1, ?2)")
            }
            "tree_nodes_fts" => {
                format!("INSERT INTO {surface_identifier}(rowid, title) VALUES (?1, ?2)")
            }
            other => anyhow::bail!("unsupported FTS surface {other}"),
        };
        conn.execute(&insert_sql, params![source_rowid, check.token])?;
    }
    Ok(())
}

#[test]
fn legacy_snapshot_rejects_partial_fts_index_corruption_with_external_content_check() {
    let _test_guard = serialize_liveness_test();
    for table in [
        "codex_fts",
        "snippets_fts",
        "chat_messages_fts",
        "tree_nodes_fts",
    ] {
        assert_snapshot_rejects_mutation(&format!("{table}-partial-index"), |conn| {
            replace_fts_index_with_only_manifest_tokens(conn, table)
        });
    }
}

#[test]
fn legacy_snapshot_rejects_scene_event_identity_corruption_for_both_projects() {
    let _test_guard = serialize_liveness_test();
    for (label, sql) in [
        (
            "scene-events-default-delete",
            "DELETE FROM scene_events
              WHERE scene_id = 'default-project-scene'
                AND event_id = 'default-project-event'",
        ),
        (
            "scene-events-gate-delete",
            "DELETE FROM scene_events
              WHERE scene_id = 'gate-a2-scene'
                AND event_id = 'gate-a2-event'",
        ),
        (
            "scene-events-default-scene-cross-project",
            "UPDATE scene_events SET scene_id = 'gate-a2-scene'
              WHERE scene_id = 'default-project-scene'
                AND event_id = 'default-project-event'",
        ),
        (
            "scene-events-gate-scene-cross-project",
            "UPDATE scene_events SET scene_id = 'default-project-scene'
              WHERE scene_id = 'gate-a2-scene'
                AND event_id = 'gate-a2-event'",
        ),
        (
            "scene-events-default-event-cross-project",
            "UPDATE scene_events SET event_id = 'gate-a2-event'
              WHERE scene_id = 'default-project-scene'
                AND event_id = 'default-project-event'",
        ),
        (
            "scene-events-gate-event-cross-project",
            "UPDATE scene_events SET event_id = 'default-project-event'
              WHERE scene_id = 'gate-a2-scene'
                AND event_id = 'gate-a2-event'",
        ),
    ] {
        assert_snapshot_rejects_mutation(label, |conn| {
            conn.execute(sql, [])?;
            Ok(())
        });
    }
    assert_snapshot_rejects_mutation("scene-events-cross-project-swap", |conn| {
        conn.execute_batch(
            "DELETE FROM scene_events;
             INSERT INTO scene_events (scene_id, event_id, incarnation_token)
             VALUES
               ('default-project-scene', 'gate-a2-event', 'default-project-scene@v0'),
               ('gate-a2-scene', 'default-project-event', 'gate-a2-scene@v0');",
        )?;
        Ok(())
    });
}

#[test]
fn legacy_snapshot_rejects_each_seeded_second_project_content_or_identity_corruption() {
    let _test_guard = serialize_liveness_test();
    for (label, sql) in [
        (
            "projects-content",
            "UPDATE projects SET title = 'corrupted' WHERE id = 'default-project'",
        ),
        (
            "project-settings-content",
            "UPDATE project_settings SET value = 'corrupted'
              WHERE project_id = 'default-project' AND key = 'release-language'",
        ),
        (
            "map-boards-content",
            "UPDATE map_boards SET title = 'corrupted' WHERE id = 'default-project-board'",
        ),
        (
            "codex-types-content",
            "UPDATE codex_types SET label = 'corrupted'
              WHERE project_id = 'default-project' AND slug = 'character'",
        ),
        (
            "tree-nodes-content",
            "UPDATE tree_nodes SET title = 'corrupted' WHERE id = 'default-project-scene'",
        ),
        (
            "codex-entries-content",
            "UPDATE codex_entries SET name = 'corrupted' WHERE id = 'default-project-codex'",
        ),
        (
            "events-content",
            "UPDATE events SET note = 'corrupted' WHERE id = 'default-project-event'",
        ),
        (
            "scene-events-identity",
            "UPDATE scene_events SET scene_id = 'gate-a2-scene'
              WHERE scene_id = 'default-project-scene' AND event_id = 'default-project-event'",
        ),
        (
            "chat-sessions-content",
            "UPDATE chat_sessions SET title = 'corrupted'
              WHERE id = 'default-project-session'",
        ),
        (
            "chat-messages-content",
            "UPDATE chat_messages SET content = 'corrupted'
              WHERE id = 'default-project-assistant-message'",
        ),
        (
            "snippets-content",
            "UPDATE snippets SET title = 'corrupted' WHERE id = 'default-project-snippet'",
        ),
        (
            "audit-content",
            "UPDATE ai_audit_events SET payload = '{\"corrupted\":true}'
              WHERE project_id = 'default-project' AND sequence = 2",
        ),
        (
            "app-settings-identity",
            "UPDATE app_settings SET key = 'corrupted.release-fixture'
              WHERE key = 'default-project.release-fixture'",
        ),
    ] {
        assert_snapshot_rejects_mutation(label, |conn| {
            conn.execute(sql, [])?;
            Ok(())
        });
    }
}

fn seed_prepared_application(db: &Database) -> (String, String, String, String) {
    let run_id = "run-c2zc-prepared";
    let task_id = "task-c2zc-prepared";
    let set_id = "set-c2zc-prepared";
    let proposal_id = "proposal-c2zc-prepared";
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: PROJECT_ID.to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-c2zc-prepared".to_string(),
            snapshot_digest: Some(format!("v0@{NOW}")),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create prepared source run");
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: "key-c2zc-prepared".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: prepared_event_payload(),
                reconciliation_envelope: Some(prepared_envelope(run_id, task_id)),
            }],
        },
    )
    .expect("save prepared proposal");
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("saved proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("saved revision id")
        .to_string();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_id: saved_proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("c2zc-test".to_string()),
        },
    )
    .expect("approve prepared proposal");
    (
        run_id.to_string(),
        set_id.to_string(),
        saved_proposal_id,
        revision_id,
    )
}

fn seed_previous_release_application(
    db: &Database,
    project_id: &str,
    scene_id: &str,
    source_identity: &str,
    revision_token: &str,
    identity: &str,
) -> (String, String, String, String, String) {
    let run_id = format!("run-c2zc-previous-release-{identity}");
    let task_id = format!("task-c2zc-previous-release-{identity}");
    let set_id = format!("set-c2zc-previous-release-{identity}");
    let proposal_id = format!("proposal-c2zc-previous-release-{identity}");
    let event_id = format!("event-c2zc-previous-release-{identity}");
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: project_id.to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-c2zc-previous-release-{identity}"),
            snapshot_digest: Some(revision_token.to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create previous-release application source run");
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: "key-c2zc-previous-release".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: prepared_event_payload_for(
                    &event_id,
                    scene_id,
                    "C2-ZC previous-release event",
                ),
                reconciliation_envelope: Some(prepared_envelope_for(
                    source_identity,
                    revision_token,
                    &run_id,
                    &task_id,
                )),
            }],
        },
    )
    .expect("save previous-release application proposal");
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("saved previous-release proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("saved previous-release revision id")
        .to_string();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: project_id.to_string(),
            proposal_id: saved_proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some(format!("c2zc-upgrade-test-{identity}")),
        },
    )
    .expect("approve previous-release application proposal");
    (run_id, set_id, saved_proposal_id, revision_id, event_id)
}

fn apply_previous_release_application(
    db: &Database,
    project_id: &str,
    scene_id: &str,
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
    event_id: &str,
    expected_tail_ordinal: Option<String>,
    identity: &str,
) -> String {
    let request_id = format!("request-c2zc-previous-release-{identity}");
    let session_id = format!("session-c2zc-previous-release-{identity}");
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: project_id.to_string(),
            run_id: run_id.to_string(),
            proposal_set_id: set_id.to_string(),
            request_id: request_id.clone(),
            plan_digest: "client-digest-ignored".to_string(),
            session_id: session_id.clone(),
            surface: Some("narrative-extraction".to_string()),
            operations: vec![CommitOperation {
                kind: "chronicle.event.create".to_string(),
                payload: prepared_event_payload_for(
                    event_id,
                    scene_id,
                    "C2-ZC previous-release event",
                ),
                proposal_id: proposal_id.to_string(),
                revision_id: revision_id.to_string(),
            }],
            applications: vec![CommitApplicationRef {
                proposal_id: proposal_id.to_string(),
                revision_id: revision_id.to_string(),
            }],
            expected_tail_ordinal,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )
    .expect("prepare previous-release application commit");
    let applied = narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: project_id.to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("previous-release prepared commit id")
                .to_string(),
            request_id,
            session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply previous-release application commit");
    assert_eq!(applied["status"], "applied");
    application_id_for_commit(db, &applied)
}

fn current_scene_revision_token(db: &Database, project_id: &str, scene_id: &str) -> String {
    db.with_conn(|conn| {
        let (version, updated_at): (i64, String) = conn.query_row(
            "SELECT version, updated_at
               FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            params![scene_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(format!("v{version}@{updated_at}"))
    })
    .expect("read migrated scene revision token")
}

fn current_event_tail_ordinal(db: &Database, project_id: &str) -> Option<String> {
    db.with_conn(|conn| {
        Ok::<_, anyhow::Error>(
            conn.query_row(
                "SELECT ordinal
                   FROM events
                  WHERE project_id = ?1
                  ORDER BY ordinal DESC, id DESC
                  LIMIT 1",
                [project_id],
                |row| row.get(0),
            )
            .optional()?,
        )
    })
    .expect("read project Chronicle tail")
}

fn drain_incremental_freshness_until_idle(db: &Database, label: &str) {
    for attempt in 0..32 {
        let outcome = run_incremental_freshness_cycle(db).unwrap_or_else(|error| {
            panic!("{label}: incremental cycle {attempt} failed: {error:#}")
        });
        match outcome {
            grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle => return,
            grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(
                summary,
            ) => {
                assert!(
                    !summary.run_id.trim().is_empty(),
                    "{label}: processed cycle ID missing"
                );
                assert!(
                    summary.through_sequence_inclusive >= summary.from_sequence_exclusive,
                    "{label}: processed cycle sequence range is invalid: {summary:?}"
                );
            }
        }
    }
    panic!("{label}: bounded incremental drain did not reach Idle");
}

fn expected_reserved_semantic_index_counts() -> BTreeMap<String, usize> {
    BTreeMap::from([
        ("metadataRows".to_string(), 0),
        ("activeD1HeadRows".to_string(), 0),
        ("v1EdgeRows".to_string(), 0),
        ("consumerFreshnessRows".to_string(), 0),
    ])
}

fn assert_project_keyset<T>(map: &BTreeMap<String, T>, expected: &[String], label: &str) {
    assert_eq!(
        map.keys().cloned().collect::<Vec<_>>(),
        expected,
        "{label} must cover exactly the expected project identities"
    );
}

fn assert_verify_coverage_evidence(
    db: &Database,
    outcome: &grimodex_db::narrative_extraction::VerifyRunOutcome,
    expected_epoch_id: &str,
) -> Value {
    assert!(
        !outcome.run_id.trim().is_empty(),
        "Verify Run ID must be present"
    );
    assert_eq!(outcome.semantic_epoch_id, expected_epoch_id);
    let coverage = production_verify_check_coverage();
    assert_eq!(coverage["complete"], true);
    assert_eq!(coverage["required"].as_array().map(Vec::len), Some(13));
    assert_eq!(coverage["covered"].as_array().map(Vec::len), Some(13));
    assert_eq!(coverage["missing"], json!([]));

    let expected_reserved = expected_reserved_semantic_index_counts();
    assert_eq!(
        outcome
            .report
            .semantic_index_dependency_set_digest
            .observed_counts,
        expected_reserved
    );
    assert_eq!(
        outcome
            .report
            .semantic_index_generation_correspondence
            .observed_counts,
        expected_reserved
    );

    let stored = db
        .with_conn(|conn| {
            let raw: String = conn.query_row(
                "SELECT outcome_summary_json
                   FROM narrative_extraction_runs
                  WHERE id = ?1",
                [outcome.run_id.as_str()],
                |row| row.get(0),
            )?;
            Ok::<_, anyhow::Error>(serde_json::from_str::<Value>(&raw)?)
        })
        .expect("read persisted Verify evidence");
    assert_eq!(stored["semanticEpochId"], expected_epoch_id);
    assert_eq!(stored["reportDigest"], outcome.report_digest);
    assert_eq!(stored["graphStateDigest"], outcome.graph_state_digest);
    assert_eq!(
        stored["report"],
        serde_json::to_value(&outcome.report).expect("serialize Verify report")
    );
    assert_eq!(stored["checkCoverage"], coverage);
    assert_eq!(
        stored["outcomeDigest"],
        canonical_verify_outcome_digest(&stored).expect("recompute Verify outcome digest")
    );
    stored
}

fn assert_clean_verify_evidence(
    db: &Database,
    outcome: &grimodex_db::narrative_extraction::VerifyRunOutcome,
    expected_epoch_id: &str,
) {
    assert_verify_coverage_evidence(db, outcome, expected_epoch_id);
    assert!(
        outcome.report.is_consistent(),
        "Verify report is inconsistent: {outcome:?}"
    );
    assert!(
        outcome.report.is_complete(),
        "Verify report is incomplete: {outcome:?}"
    );
    assert!(
        outcome.report.is_clean(),
        "Verify report is not clean: {outcome:?}"
    );
    assert!(!outcome.report.requires_rebuild());
    assert!(outcome
        .report
        .finding_observation_ids_outside_current_epoch
        .is_empty());
}

fn assert_maintenance_run_bound_to_epoch(
    db: &Database,
    project_id: &str,
    run_id: &str,
    expected_run_kind: &str,
    expected_epoch_id: &str,
) {
    assert!(
        !run_id.trim().is_empty(),
        "{expected_run_kind} Run ID missing"
    );
    let (stored_project_id, stored_run_kind, stored_epoch_id, status): (
        String,
        String,
        Option<String>,
        String,
    ) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT project_id, run_kind, semantic_epoch_id, status
                   FROM narrative_extraction_runs
                  WHERE id = ?1",
                [run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .unwrap_or_else(|error| panic!("read {expected_run_kind} Run {run_id}: {error:#}"));
    assert_eq!(stored_project_id, project_id);
    assert_eq!(stored_run_kind, expected_run_kind);
    assert_eq!(stored_epoch_id.as_deref(), Some(expected_epoch_id));
    assert_eq!(status, "completed");
}

fn assert_project_freshness_liveness(db: &Database, project_id: &str, epoch_id: &str) {
    let (
        acknowledged,
        last_error,
        cursor_epoch,
        active_run_id,
        reserved_through,
        lease_owner,
        lease_expires_at,
        feed_head,
        completed_runs,
        active_runs,
    ): (
        i64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        i64,
    ) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT cursor.acknowledged_through_sequence,
                        cursor.last_error,
                        cursor.semantic_epoch_id,
                        cursor.active_run_id,
                        cursor.reserved_through_sequence,
                        cursor.lease_owner,
                        cursor.lease_expires_at,
                        COALESCE((SELECT MAX(canonical_sequence)
                                    FROM narrative_change_events
                                   WHERE project_id = ?1), 0),
                        (SELECT COUNT(*)
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1
                            AND run_kind = 'freshness-evaluation'
                            AND semantic_epoch_id = ?2
                            AND status = 'completed'),
                        (SELECT COUNT(*)
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1
                            AND run_kind = 'freshness-evaluation'
                            AND status IN ('pending', 'running'))
                   FROM narrative_change_cursors cursor
                  WHERE cursor.project_id = ?1
                    AND cursor.consumer_id = 'narrative-incremental-freshness/v1'",
                params![project_id, epoch_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                    ))
                },
            )?)
        })
        .unwrap_or_else(|error| panic!("read freshness/liveness for {project_id}: {error:#}"));
    assert_eq!(
        acknowledged, feed_head,
        "{project_id} cursor must reach Feed head"
    );
    assert_eq!(last_error, None, "{project_id} cursor must be error-free");
    assert_eq!(active_run_id, None, "{project_id} cursor must be idle");
    assert_eq!(
        reserved_through, None,
        "{project_id} cursor must have no reservation"
    );
    assert_eq!(
        lease_owner, None,
        "{project_id} cursor must have no lease owner"
    );
    assert_eq!(
        lease_expires_at, None,
        "{project_id} cursor must have no lease"
    );
    assert!(
        cursor_epoch.is_none() || cursor_epoch.as_deref() == Some(epoch_id),
        "{project_id} idle cursor may be NULL, but any bound Epoch must be current: {cursor_epoch:?}"
    );
    assert!(
        completed_runs > 0,
        "{project_id} needs a completed current-Epoch Freshness Run"
    );
    assert_eq!(
        active_runs, 0,
        "{project_id} must have no active Freshness Run"
    );
}

fn read_c2zc_persistence_counts(db: &Database) -> (i64, i64, i64) {
    db.with_conn(|conn| {
        Ok::<_, anyhow::Error>((
            conn.query_row(
                "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
                [C2_ZC_CUTOVER_MIGRATION_ID],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_semantic_epochs",
                [],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_consumer_freshness",
                [],
                |row| row.get(0),
            )?,
        ))
    })
    .expect("read C2-ZC persistence counts")
}

fn read_project_finding_repair_counts(db: &Database, project_id: &str) -> (i64, i64) {
    db.with_conn(|conn| {
        Ok::<_, anyhow::Error>((
            conn.query_row(
                "SELECT COUNT(*)
                       FROM narrative_maintenance_finding_observations
                      WHERE project_id = ?1",
                [project_id],
                |row| row.get(0),
            )?,
            conn.query_row(
                "SELECT COUNT(*)
                       FROM narrative_extraction_runs
                      WHERE project_id = ?1 AND run_kind = 'dependency-repair'",
                [project_id],
                |row| row.get(0),
            )?,
        ))
    })
    .unwrap_or_else(|error| panic!("read Finding/Repair counts for {project_id}: {error:#}"))
}

fn prepared_commit_payload(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: PROJECT_ID.to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: "request-c2zc-prepared".to_string(),
        plan_digest: "client-digest-ignored".to_string(),
        session_id: "session-c2zc-prepared".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: prepared_event_payload(),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        applications: vec![CommitApplicationRef {
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

fn temporal_node_payload(node_id: &str) -> Value {
    json!({
        "nodeId": node_id,
        "timelineKind": "primary",
        "subject": {
            "kind": "named-period",
            "label": "C2-ZC idempotent temporal node",
        },
        "shape": "point",
    })
}

fn seed_approved_temporal_node(
    db: &Database,
    run_id: &str,
    task_id: &str,
    set_id: &str,
    proposal_id: &str,
    node_id: &str,
) -> (String, String, String, String) {
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: PROJECT_ID.to_string(),
            surface_path_id: "temporal.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "temporal" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: Some(format!("v0@{NOW}")),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "temporal.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create temporal source run");
    // The public CreateRun DTO deliberately leaves the Epoch binding to the
    // caller's live workspace seam.  Bind this test-owned proposal Run to the
    // fixture's current Epoch so the incremental runtime can prove its
    // producer-epoch guard rather than conservatively publishing Unknown.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET semantic_epoch_id = ?1
              WHERE id = ?2 AND project_id = ?3",
            params![EPOCH_ID, run_id, PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("bind temporal proposal Run to the fixture Epoch");
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "temporal.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("key-{run_id}"),
                kind: "temporal.node.ensure".to_string(),
                payload_json: temporal_node_payload(node_id),
                reconciliation_envelope: Some(prepared_envelope(run_id, task_id)),
            }],
        },
    )
    .expect("save temporal proposal");
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("saved temporal proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("saved temporal revision id")
        .to_string();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_id: saved_proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("c2zc-test".to_string()),
        },
    )
    .expect("approve temporal proposal");
    (
        run_id.to_string(),
        set_id.to_string(),
        saved_proposal_id,
        revision_id,
    )
}

fn apply_temporal_node(
    db: &Database,
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
    node_id: &str,
    request_id: &str,
) -> Value {
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: PROJECT_ID.to_string(),
            run_id: run_id.to_string(),
            proposal_set_id: set_id.to_string(),
            request_id: request_id.to_string(),
            plan_digest: format!("plan-{run_id}"),
            session_id: format!("session-{run_id}"),
            surface: Some("narrative-extraction".to_string()),
            operations: vec![CommitOperation {
                kind: "temporal.node.ensure".to_string(),
                payload: temporal_node_payload(node_id),
                proposal_id: proposal_id.to_string(),
                revision_id: revision_id.to_string(),
            }],
            applications: vec![CommitApplicationRef {
                proposal_id: proposal_id.to_string(),
                revision_id: revision_id.to_string(),
            }],
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )
    .expect("prepare temporal node commit");
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: PROJECT_ID.to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared temporal commit id")
                .to_string(),
            request_id: request_id.to_string(),
            session_id: format!("session-{run_id}"),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply temporal node commit")
}

fn application_id_for_commit(db: &Database, commit: &Value) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_proposal_applications WHERE commit_id = ?1",
            [commit["commitId"].as_str().expect("commit id")],
            |row| row.get(0),
        )?)
    })
    .expect("read temporal Application id")
}

#[test]
fn previous_release_database_composes_into_c2zc_acceptance() {
    let _test_guard = serialize_liveness_test();
    let workspace = release_schema_fixture::temp_workspace("c2zc-upgrade-acceptance");
    let db_path = release_schema_fixture::seed_previous_release_workspace(&workspace);
    release_schema_fixture::assert_previous_release_fixture_shape(&db_path);

    let outcome = migration_supervisor::open_or_migrate_workspace_db(&workspace)
        .expect("previous-release database must open through migration supervisor");
    let opened = match outcome {
        WorkspaceOpenDbOutcome::Migrated {
            opened,
            from_schema,
            to_schema,
            receipt_path,
        } => {
            assert_eq!(from_schema, LAST_PUBLIC_RELEASE_SCHEMA_VERSION);
            assert_eq!(to_schema, SCHEMA_VERSION);
            assert!(receipt_path.is_file(), "migration receipt must exist");
            opened
        }
        other => panic!("expected a real previous-release migration, got {other:?}"),
    };
    release_schema_fixture::assert_release_fixture_rows(&db_path);
    let legacy_snapshot_path = release_schema_fixture::latest_migration_snapshot(&workspace);
    let legacy_snapshot = load_legacy_snapshot_baseline(&legacy_snapshot_path)
        .unwrap_or_else(|error| panic!("load immutable release snapshot contract: {error:#}"));
    let post_migration_legacy_rows_exact = legacy_snapshot.assert_database(&db_path);

    let project_ids = opened
        .database
        .with_conn(|conn| {
            Ok::<_, anyhow::Error>(
                conn.prepare("SELECT id FROM projects ORDER BY id")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            )
        })
        .expect("list migrated projects");
    assert!(
        project_ids
            == EXPECTED_UPGRADE_PROJECT_IDS
                .iter()
                .map(|project_id| (*project_id).to_string())
                .collect::<Vec<_>>(),
        "migration must expose exactly the expected two project identities: {project_ids:?}"
    );
    assert_eq!(
        release_schema_fixture::PROJECT_ID,
        "gate-a2-project",
        "the explicit previous-release fixture project identity is part of this AC"
    );

    // Both explicit project identities are present in the previous-release
    // image and have no current C2-ZC Application Graph. Create a real
    // Application for each through the public proposal/review/apply path while
    // the legacy mirror is still authoritative; the real Backfill below then
    // imports each dependency into the current Graph.
    enable_manual_apply_preserving_flags(&opened.database);
    let default_source_identity =
        format!("project:scene:{}", release_schema_fixture::SECOND_SCENE_ID);
    let default_revision_token = current_scene_revision_token(
        &opened.database,
        release_schema_fixture::SECOND_PROJECT_ID,
        release_schema_fixture::SECOND_SCENE_ID,
    );
    let (
        default_application_source_run_id,
        default_application_set_id,
        default_proposal_id,
        default_revision_id,
        default_event_id,
    ) = seed_previous_release_application(
        &opened.database,
        release_schema_fixture::SECOND_PROJECT_ID,
        release_schema_fixture::SECOND_SCENE_ID,
        &default_source_identity,
        &default_revision_token,
        release_schema_fixture::SECOND_PROJECT_ID,
    );
    let default_application_id = apply_previous_release_application(
        &opened.database,
        release_schema_fixture::SECOND_PROJECT_ID,
        release_schema_fixture::SECOND_SCENE_ID,
        &default_application_source_run_id,
        &default_application_set_id,
        &default_proposal_id,
        &default_revision_id,
        &default_event_id,
        current_event_tail_ordinal(&opened.database, release_schema_fixture::SECOND_PROJECT_ID),
        release_schema_fixture::SECOND_PROJECT_ID,
    );
    let source_identity = format!("project:scene:{}", release_schema_fixture::SCENE_ID);
    let revision_token = current_scene_revision_token(
        &opened.database,
        release_schema_fixture::PROJECT_ID,
        release_schema_fixture::SCENE_ID,
    );
    let (application_source_run_id, application_set_id, proposal_id, revision_id, event_id) =
        seed_previous_release_application(
            &opened.database,
            release_schema_fixture::PROJECT_ID,
            release_schema_fixture::SCENE_ID,
            &source_identity,
            &revision_token,
            "gate-a2-project",
        );
    let application_id = apply_previous_release_application(
        &opened.database,
        release_schema_fixture::PROJECT_ID,
        release_schema_fixture::SCENE_ID,
        &application_source_run_id,
        &application_set_id,
        &proposal_id,
        &revision_id,
        &event_id,
        current_event_tail_ordinal(&opened.database, release_schema_fixture::PROJECT_ID),
        "gate-a2-project",
    );
    let application_ids_by_project = BTreeMap::from([
        (
            release_schema_fixture::SECOND_PROJECT_ID.to_string(),
            default_application_id,
        ),
        (
            release_schema_fixture::PROJECT_ID.to_string(),
            application_id,
        ),
    ]);
    assert_eq!(
        application_ids_by_project
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        project_ids,
        "Application evidence must cover exactly both expected projects"
    );
    assert!(
        application_ids_by_project
            .values()
            .all(|application_id| !application_id.trim().is_empty()),
        "every expected project must return an Application ID"
    );

    // Backfill is the production release-boundary operation. It must consume
    // the legacy Application dependency rather than a test-inserted Edge.
    let mut backfill_run_ids = BTreeMap::new();
    for project_id in &project_ids {
        let backfill =
            bootstrap_legacy_dependency_backfill_for_project(&opened.database, project_id)
                .expect("run production legacy dependency backfill");
        let run_id = match backfill {
            grimodex_db::narrative_extraction::LegacyBackfillBootstrapOutcome::Ran {
                run_id,
                ..
            } => run_id,
            grimodex_db::narrative_extraction::LegacyBackfillBootstrapOutcome::AlreadyRun {
                run_id,
            } => panic!("unexpected pre-existing Backfill Run during acceptance: {run_id}"),
        };
        assert!(
            !run_id.trim().is_empty(),
            "Backfill Run ID must be returned"
        );
        backfill_run_ids.insert(project_id.clone(), run_id);
    }
    assert_project_keyset(&backfill_run_ids, &project_ids, "Backfill Run IDs");
    for project_id in &project_ids {
        let migrated_edge_count = opened
            .database
            .with_conn(|conn| {
                Ok::<_, anyhow::Error>(conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_dependency_edges
                      WHERE project_id = ?1 AND consumer_kind = 'application'
                        AND consumer_key = ?2",
                    params![project_id, application_ids_by_project[project_id]],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .unwrap_or_else(|error| {
                panic!("count {project_id} Backfill-produced Application Edges: {error:#}")
            });
        assert_eq!(
            migrated_edge_count, 1,
            "{project_id} Backfill must import its legacy dependency exactly once"
        );
    }

    // Drain the real Change Feed before the first Verify so its cursor/feed
    // check has complete current evidence for every migrated project.
    drain_incremental_freshness_until_idle(&opened.database, "after-previous-release-backfill");

    let epoch_rows: Vec<(String, String, i64)> = opened
        .database
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT project_id, id, epoch_number
                   FROM narrative_semantic_epochs
                  ORDER BY project_id ASC, epoch_number ASC, id ASC",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok::<_, anyhow::Error>(rows)
        })
        .expect("read migrated current Semantic Epochs");
    assert_eq!(
        epoch_rows.len(),
        EXPECTED_UPGRADE_PROJECT_IDS.len(),
        "exactly one current Epoch per expected migrated project"
    );
    let epoch_by_project: BTreeMap<String, String> = epoch_rows
        .iter()
        .map(|(project_id, epoch_id, epoch_number)| {
            assert_eq!(
                *epoch_number, 0,
                "previous-release upgrade starts at Epoch zero"
            );
            (project_id.clone(), epoch_id.clone())
        })
        .collect();
    assert_eq!(
        epoch_by_project.keys().cloned().collect::<Vec<_>>(),
        project_ids,
        "current Epoch map must cover exactly both expected projects"
    );
    for project_id in &project_ids {
        assert_maintenance_run_bound_to_epoch(
            &opened.database,
            project_id,
            &backfill_run_ids[project_id],
            "backfill",
            &epoch_by_project[project_id],
        );
    }

    // First Verify is a real current-Epoch diagnostic. Rebuild is still
    // deliberately absent at this point, so durable readiness must remain
    // incomplete rather than treating migration/backfill as cutover proof.
    let mut initial_verify_run_ids = BTreeMap::new();
    let mut initial_verify_evidence_by_project = BTreeMap::new();
    for project_id in &project_ids {
        let verify = run_dependency_verify_for_project(&opened.database, project_id)
            .expect("run production initial current-Epoch Verify");
        assert_eq!(
            verify.semantic_epoch_id, epoch_by_project[project_id],
            "initial Verify must bind to the project's current Epoch"
        );
        let stored = assert_verify_coverage_evidence(
            &opened.database,
            &verify,
            &epoch_by_project[project_id],
        );
        assert_maintenance_run_bound_to_epoch(
            &opened.database,
            project_id,
            &verify.run_id,
            "dependency-verify",
            &epoch_by_project[project_id],
        );
        initial_verify_evidence_by_project.insert(
            project_id.clone(),
            json!({
                "runId": verify.run_id,
                "semanticEpochId": verify.semantic_epoch_id,
                "coverage": stored["checkCoverage"].clone(),
                "reservedSemanticIndex": expected_reserved_semantic_index_counts(),
                "rebuildRequired": verify.report.requires_rebuild(),
            }),
        );
        initial_verify_run_ids.insert(project_id.clone(), verify.run_id);
    }
    assert_project_keyset(
        &initial_verify_run_ids,
        &project_ids,
        "initial Verify Run IDs",
    );
    assert_project_keyset(
        &initial_verify_evidence_by_project,
        &project_ids,
        "initial Verify evidence",
    );
    let pre_rebuild_readiness = opened
        .database
        .with_conn(|conn| inspect_workspace_cutover_readiness_with_liveness(conn, None))
        .expect("read readiness before production Rebuild");
    assert!(!pre_rebuild_readiness.durable.ready);
    assert!(
        pre_rebuild_readiness
            .reasons
            .iter()
            .any(|reason| reason.contains("derived-state-rebuild")),
        "migration plus Verify must still require Rebuild: {pre_rebuild_readiness:?}"
    );

    let mut rebuild_run_ids = BTreeMap::new();
    for project_id in &project_ids {
        let rebuild = rebuild_narrative_derived_state_for_project(&opened.database, project_id)
            .expect("run production current-Epoch Rebuild");
        let run_id = match rebuild {
            grimodex_db::narrative_extraction::RebuildDerivedStateOutcome::Ran {
                run_id, ..
            } => run_id,
            grimodex_db::narrative_extraction::RebuildDerivedStateOutcome::AlreadyRunning {
                run_id,
            } => panic!("unexpected active Rebuild Run during acceptance: {run_id}"),
        };
        assert!(!run_id.trim().is_empty(), "Rebuild Run ID must be returned");
        assert_maintenance_run_bound_to_epoch(
            &opened.database,
            project_id,
            &run_id,
            "semantic-index-rebuild",
            &epoch_by_project[project_id],
        );
        rebuild_run_ids.insert(project_id.clone(), run_id);
    }
    assert_project_keyset(&rebuild_run_ids, &project_ids, "Rebuild Run IDs");

    let mut confirmation_verify_run_ids = BTreeMap::new();
    let mut confirmation_verify_outcomes = BTreeMap::new();
    for project_id in &project_ids {
        let verify = run_dependency_verify_for_project(&opened.database, project_id)
            .expect("run production confirmation current-Epoch Verify");
        assert_clean_verify_evidence(&opened.database, &verify, &epoch_by_project[project_id]);
        assert_maintenance_run_bound_to_epoch(
            &opened.database,
            project_id,
            &verify.run_id,
            "dependency-verify",
            &epoch_by_project[project_id],
        );
        confirmation_verify_run_ids.insert(project_id.clone(), verify.run_id.clone());
        confirmation_verify_outcomes.insert(project_id.clone(), verify);
    }
    assert_project_keyset(
        &confirmation_verify_run_ids,
        &project_ids,
        "confirmation Verify Run IDs",
    );
    assert_project_keyset(
        &confirmation_verify_outcomes,
        &project_ids,
        "confirmation Verify outcomes",
    );

    // Mint liveness only from a successful shared-Rust cycle at the Feed head;
    // the test never constructs SchedulerLivenessEvidence as a bypass.
    let mut last_successful_cycle = None;
    let mut reached_idle = false;
    for attempt in 0..32 {
        let (cycle, successful_cycle) =
            run_incremental_freshness_cycle_with_liveness_capability(&opened.database)
                .unwrap_or_else(|error| panic!("final liveness cycle {attempt} failed: {error:#}"));
        last_successful_cycle = Some(successful_cycle);
        if matches!(
            cycle,
            grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
        ) {
            reached_idle = true;
            break;
        }
    }
    assert!(reached_idle, "bounded final liveness drain must reach Idle");
    let evidence = record_live_scheduler_heartbeat(
        &opened.database,
        "c2zc-upgrade-acceptance",
        1,
        last_successful_cycle.expect("successful final liveness cycle"),
    )
    .expect("register production scheduler liveness receipt");
    assert_eq!(
        evidence.project_ids, project_ids,
        "scheduler liveness receipt must cover exactly both expected projects"
    );

    let readiness = opened
        .database
        .with_conn(|conn| inspect_workspace_cutover_readiness_with_liveness(conn, Some(&evidence)))
        .expect("read final C2-ZC readiness");
    assert_eq!(readiness.state, ReadinessState::Passed);
    assert!(readiness.ready, "final readiness must pass: {readiness:?}");
    assert_eq!(readiness.scheduler_liveness.state, ReadinessState::Passed);
    assert!(readiness.scheduler_liveness.passed);
    assert_eq!(
        readiness.durable.projects.len(),
        EXPECTED_UPGRADE_PROJECT_IDS.len(),
        "durable readiness must report exactly both expected projects"
    );
    assert_eq!(
        readiness
            .durable
            .projects
            .iter()
            .map(|project| project.project_id.clone())
            .collect::<BTreeSet<_>>(),
        project_ids.iter().cloned().collect::<BTreeSet<_>>(),
        "durable readiness project identities must be exactly the expected two"
    );
    for project_id in &project_ids {
        let project = readiness
            .durable
            .projects
            .iter()
            .find(|project| project.project_id == *project_id)
            .unwrap_or_else(|| panic!("readiness missing expected project {project_id}"));
        assert_eq!(
            project.current_epoch_id.as_deref(),
            Some(epoch_by_project[project_id].as_str())
        );
        assert_project_freshness_liveness(
            &opened.database,
            project_id,
            &epoch_by_project[project_id],
        );
        assert!(
            project.ready
                || (project.incremental_runtime.reasons.len() == 1
                    && project.incremental_runtime.reasons[0]
                        == "incremental-freshness-scheduler-liveness-evidence-unavailable"),
            "project readiness must pass or expose only the external liveness bridge: {project:?}"
        );
        assert_eq!(project.legacy_backfill.state, ReadinessState::Passed);
        assert_eq!(project.verify.state, ReadinessState::Passed);
        assert_eq!(project.derived_state_rebuild.state, ReadinessState::Passed);
        assert_eq!(project.parity.state, ReadinessState::Passed);
        assert_eq!(
            project.no_active_backfill_or_repair.state,
            ReadinessState::Passed
        );
        assert_eq!(project.phase_lifecycle.state, ReadinessState::Passed);
        assert!(
            project.incremental_runtime.state == ReadinessState::Passed
                || (project.incremental_runtime.state == ReadinessState::Incomplete
                    && project.incremental_runtime.reasons.len() == 1
                    && project.incremental_runtime.reasons[0]
                        == "incremental-freshness-scheduler-liveness-evidence-unavailable"),
            "incremental runtime must either pass or expose only its documented external liveness bridge: {project:?}"
        );
        assert_eq!(
            project.verify.run_id.as_deref(),
            confirmation_verify_run_ids
                .get(project_id)
                .map(String::as_str)
        );
    }

    let (first_cutover, second_cutover) = opened
        .database
        .with_conn(|conn| {
            let first = cut_over_workspace_freshness(conn, &evidence)?;
            let second = cut_over_workspace_freshness(conn, &evidence)?;
            Ok::<_, anyhow::Error>((first, second))
        })
        .expect("activate Generic authority through production cutover API");
    assert_eq!(
        first_cutover, second_cutover,
        "cutover marker must be idempotent"
    );
    assert_eq!(first_cutover.migration_id, C2_ZC_CUTOVER_MIGRATION_ID);
    assert_eq!(
        first_cutover.contract_version,
        C2_ZC_CUTOVER_CONTRACT_VERSION
    );
    assert_eq!(
        first_cutover.authority,
        CanonicalFreshnessAuthority::GenericConsumerFreshness
    );
    let post_cutover_legacy_rows_exact = legacy_snapshot.assert_database(&db_path);

    let canonical_before_by_project = opened
        .database
        .with_conn(|conn| {
            let mut rows = BTreeMap::new();
            for project_id in &project_ids {
                let application_id = &application_ids_by_project[project_id];
                let row = canonical_application_freshness(conn, project_id, application_id)?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "{project_id} Application must have Generic Freshness after cutover"
                        )
                    })?;
                assert_eq!(
                    row.authority,
                    CanonicalFreshnessAuthority::GenericConsumerFreshness
                );
                assert_eq!(row.semantic_epoch_id, epoch_by_project[project_id]);
                assert_eq!(row.evidence_freshness, "fresh");
                assert_eq!(row.build_action, "none");
                assert_eq!(
                    row.last_evaluated_run_id.as_deref(),
                    Some(rebuild_run_ids[project_id].as_str())
                );
                rows.insert(project_id.clone(), row);
            }
            Ok::<_, anyhow::Error>(rows)
        })
        .expect("read every project Generic canonical Application Freshness after cutover");

    let persistence_before_reopen = read_c2zc_persistence_counts(&opened.database);
    assert_eq!(
        persistence_before_reopen.0, 1,
        "exactly one C2-ZC marker is allowed"
    );

    // Corrupt only the compatibility projection after cutover. The canonical
    // reread must continue to return the Generic row, proving no legacy
    // fallback or authority weakening.
    let canonical_after_legacy_mutation_by_project = opened
        .database
        .with_conn(|conn| {
            for application_id in application_ids_by_project.values() {
                conn.execute(
                    "UPDATE narrative_projection_freshness
                        SET status = 'source-missing'
                      WHERE application_id = ?1",
                    [application_id],
                )?;
            }
            let mut rows = BTreeMap::new();
            for project_id in &project_ids {
                let application_id = &application_ids_by_project[project_id];
                let row = canonical_application_freshness(conn, project_id, application_id)?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "{project_id} Generic canonical row must remain available after legacy mutation"
                        )
                    })?;
                assert_eq!(row, canonical_before_by_project[project_id]);
                rows.insert(project_id.clone(), row);
            }
            Ok::<_, anyhow::Error>(rows)
        })
        .expect("read every project canonical Generic row after legacy compatibility mutation");
    let legacy_mutation_ignored =
        canonical_after_legacy_mutation_by_project == canonical_before_by_project;

    let (finding_count, automatic_repair_run_count): (i64, i64) = opened
        .database
        .with_conn(|conn| {
            Ok::<_, anyhow::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_maintenance_finding_observations",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE run_kind = 'dependency-repair'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("count final Findings and automatic Repair Runs");
    assert_eq!(
        finding_count, 0,
        "clean upgrade must not create unresolved Findings"
    );
    assert_eq!(
        automatic_repair_run_count, 0,
        "clean upgrade must not launch an automatic Repair"
    );
    let mut finding_repair_by_project = BTreeMap::new();
    for project_id in &project_ids {
        let (project_finding_count, project_repair_count) =
            read_project_finding_repair_counts(&opened.database, project_id);
        assert_eq!(
            project_finding_count, 0,
            "{project_id} must have no unresolved Finding"
        );
        assert_eq!(
            project_repair_count, 0,
            "{project_id} must have no automatic Repair Run"
        );
        finding_repair_by_project.insert(
            project_id.clone(),
            json!({
                "findingCount": project_finding_count,
                "automaticRepairRunCount": project_repair_count,
            }),
        );
    }

    // Every production phase Run must retain the current Epoch selected by
    // Native; no caller-supplied Epoch or synthetic Generic row is accepted.
    opened
        .database
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT project_id, run_kind, semantic_epoch_id
                   FROM narrative_extraction_runs
                  WHERE run_kind IN ('backfill', 'semantic-index-rebuild', 'dependency-verify')
                  ORDER BY project_id ASC, run_kind ASC, created_at ASC, id ASC",
            )?;
            for row in statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })? {
                let (project_id, run_kind, semantic_epoch_id) = row?;
                assert_eq!(
                    semantic_epoch_id.as_deref(),
                    epoch_by_project.get(&project_id).map(String::as_str),
                    "{run_kind} Run must bind to its project's current Epoch"
                );
            }
            Ok::<_, anyhow::Error>(())
        })
        .expect("verify production phase Epoch bindings");

    release_schema_fixture::assert_release_fixture_rows(&db_path);

    // Release the supervisor lease and the authoritative connection before a
    // real supervisor reopen. The reopened authority must observe the same
    // marker, Epoch cardinality, Generic row cardinality, and canonical value.
    let migration_supervisor::OpenedWorkspaceDb { database, lease } = opened;
    drop(database);
    drop(lease);
    let reopened = migration_supervisor::open_or_migrate_workspace_db(&workspace)
        .expect("reopen migrated workspace through migration supervisor");
    let reopened = match reopened {
        WorkspaceOpenDbOutcome::Ready { opened, .. } => opened,
        other => panic!("reopen must be Ready without another migration: {other:?}"),
    };
    let persistence_after_reopen = read_c2zc_persistence_counts(&reopened.database);
    assert_eq!(persistence_after_reopen, persistence_before_reopen);
    let canonical_after_reopen_by_project = reopened
        .database
        .with_conn(|conn| {
            let mut rows = BTreeMap::new();
            for project_id in &project_ids {
                let application_id = &application_ids_by_project[project_id];
                let row = canonical_application_freshness(conn, project_id, application_id)?
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "{project_id} Generic canonical row must survive supervisor reopen"
                        )
                    })?;
                rows.insert(project_id.clone(), row);
            }
            Ok::<_, anyhow::Error>(rows)
        })
        .expect("read every project canonical Generic row after supervisor reopen");
    assert_eq!(
        canonical_after_reopen_by_project,
        canonical_before_by_project
    );
    release_schema_fixture::assert_release_fixture_rows(&db_path);
    let post_reopen_legacy_rows_exact = legacy_snapshot.assert_database(&db_path);
    let legacy_rows_exact = post_reopen_legacy_rows_exact;

    let epoch_counts_unchanged = persistence_after_reopen.1 == persistence_before_reopen.1;
    let authority_counts_unchanged = persistence_after_reopen.2 == persistence_before_reopen.2;
    assert!(epoch_counts_unchanged);
    assert!(authority_counts_unchanged);
    let project_receipt_evidence = project_ids
        .iter()
        .map(|project_id| {
            let canonical = &canonical_after_reopen_by_project[project_id];
            json!({
                "projectId": project_id,
                "applicationId": application_ids_by_project[project_id],
                "currentEpochId": epoch_by_project[project_id],
                "backfillRunId": backfill_run_ids[project_id],
                "initialVerify": initial_verify_evidence_by_project[project_id],
                "rebuildRunId": rebuild_run_ids[project_id],
                "confirmationVerifyRunId": confirmation_verify_run_ids[project_id],
                "readiness": {
                    "state": "Passed",
                    "ready": true,
                    "freshnessLiveness": true,
                },
                "findingRepair": finding_repair_by_project[project_id],
                "canonical": canonical,
            })
        })
        .collect::<Vec<_>>();
    let receipt = json!({
        "sourceSchema": LAST_PUBLIC_RELEASE_SCHEMA_VERSION,
        "targetSchema": SCHEMA_VERSION,
        "projects": project_ids,
        "epochs": epoch_rows
            .iter()
            .map(|(project_id, epoch_id, epoch_number)| json!({
                "projectId": project_id,
                "epochId": epoch_id,
                "epochNumber": epoch_number,
            }))
            .collect::<Vec<_>>(),
        "legacyRowsExact": legacy_rows_exact,
        "legacySnapshot": {
            "comparison": "immutable supervisor pre-migration snapshot",
            "scope": "all seeded legacy user rows across the exported release-fixture table manifest, including derived FTS rows",
            "checks": {
                "postMigration": post_migration_legacy_rows_exact,
                "postCutover": post_cutover_legacy_rows_exact,
                "postReopen": post_reopen_legacy_rows_exact,
            },
            "tables": release_schema_fixture::LEGACY_SEED_TABLES
                .iter()
                .map(|descriptor| json!({
                    "table": descriptor.table,
                    "orderBy": descriptor.order_by,
                    "identityColumns": descriptor.identity_columns,
                    "scope": descriptor.scope.label(),
                }))
                .collect::<Vec<_>>(),
            "ftsMatchChecks": release_schema_fixture::LEGACY_FTS_TOKEN_CHECKS
                .iter()
                .map(|check| json!({
                    "surface": check.surface_table,
                    "source": check.source_table,
                    "sourceId": check.source_id,
                    "token": check.token,
                }))
                .collect::<Vec<_>>(),
        },
        "phases": {
            "backfillRunIds": backfill_run_ids,
            "initialVerifyRunIds": initial_verify_run_ids,
            "rebuildRunIds": rebuild_run_ids,
            "confirmationVerifyRunIds": confirmation_verify_run_ids,
        },
        "projectEvidence": project_receipt_evidence,
        "verify": {
            "coverage": {
                "complete": true,
                "requiredCount": 13,
                "coveredCount": 13,
                "missing": [],
            },
            "reservedSemanticIndex": expected_reserved_semantic_index_counts(),
            "reportClean": confirmation_verify_outcomes.values().all(|outcome| outcome.report.is_clean()),
            "rebuildRequired": confirmation_verify_outcomes.values().any(|outcome| outcome.report.requires_rebuild()),
            "findingCount": finding_count,
            "automaticRepairRunCount": automatic_repair_run_count,
        },
        "readiness": {
            "state": "Passed",
            "ready": readiness.ready,
            "allProjectGatesPassed": readiness.ready,
        },
        "cutover": {
            "migrationId": first_cutover.migration_id,
            "contractVersion": first_cutover.contract_version,
            "markerCount": persistence_after_reopen.0,
            "secondCallSameReceipt": first_cutover == second_cutover,
        },
        "canonical": {
            "byProject": canonical_after_reopen_by_project,
            "legacyMutationIgnored": legacy_mutation_ignored,
        },
        "reopen": {
            "markerCount": persistence_after_reopen.0,
            "epochCountsUnchanged": epoch_counts_unchanged,
            "authorityCountsUnchanged": authority_counts_unchanged,
        },
    });
    assert_eq!(receipt["verify"]["coverage"]["requiredCount"], 13);
    assert_eq!(receipt["verify"]["coverage"]["coveredCount"], 13);
    assert_eq!(receipt["verify"]["coverage"]["missing"], json!([]));
    assert_eq!(
        receipt["verify"]["reservedSemanticIndex"],
        json!(expected_reserved_semantic_index_counts())
    );
    println!(
        "C2ZC_UPGRADE_ACCEPTANCE_RECEIPT={}",
        serde_json::to_string_pretty(&receipt).expect("serialize acceptance receipt")
    );
    let migration_supervisor::OpenedWorkspaceDb {
        database: reopened_database,
        lease: reopened_lease,
    } = reopened;
    drop(reopened_database);
    drop(reopened_lease);
}

#[test]
fn prepared_apply_feed_without_locator_evaluates_only_declared_application() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed all C2-ZA durable prerequisites");
    let evidence = scheduler_heartbeat(&db, "c2zc-apply-authority", 1);
    db.with_conn(|conn| cut_over_workspace_freshness(conn, &evidence))
        .expect("activate Generic Consumer Freshness");
    enable_manual_apply(&db);

    let baseline_before: (Option<String>, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT last_evaluated_run_id, updated_at
                   FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'application'
                    AND consumer_key = ?2",
                params![PROJECT_ID, APPLICATION_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read baseline Generic row");

    let (run_id, set_id, proposal_id, revision_id) = seed_prepared_application(&db);
    let prepared = narrative_extraction_prepare_commit(
        &db,
        prepared_commit_payload(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare through public commit API");
    let applied = narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: PROJECT_ID.to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared commit id")
                .to_string(),
            request_id: "request-c2zc-prepared".to_string(),
            session_id: "session-c2zc-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply through public commit API");
    assert_eq!(applied["status"], "applied");

    let application_id: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_proposal_applications
                  WHERE commit_id = ?1",
                [applied["commitId"].as_str().expect("applied commit id")],
                |row| row.get(0),
            )?)
        })
        .expect("read applied Application id");
    assert_ne!(application_id, APPLICATION_ID);

    db.with_conn(|conn| {
        let seeded_row: (String, String, String, Option<String>) = conn.query_row(
            "SELECT evidence_freshness, build_action, semantic_epoch_id, last_evaluated_run_id
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, application_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            seeded_row,
            (
                "unknown".to_string(),
                "manual".to_string(),
                EPOCH_ID.to_string(),
                None,
            ),
            "normal post-cutover Apply seeds canonical Unknown/Manual Freshness before Feed evaluation"
        );
        let canonical_seed = canonical_application_freshness(conn, PROJECT_ID, &application_id)?
            .expect("the deliberate Unknown/Manual seed is canonical before Feed evaluation");
        assert_eq!(canonical_seed.evidence_freshness, "unknown");
        assert_eq!(canonical_seed.build_action, "manual");
        assert_eq!(canonical_seed.last_evaluated_run_id, None);
        let application_ids_json: String = conn.query_row(
            "SELECT t.application_ids_json
               FROM narrative_change_transactions t
              WHERE t.commit_id = ?1",
            [applied["commitId"].as_str().expect("commit id")],
            |row| row.get(0),
        )?;
        let application_ids: Vec<String> = serde_json::from_str(&application_ids_json)?;
        assert_eq!(application_ids, vec![application_id.clone()]);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify typed Application identity survived Feed transaction");

    let outcome = run_incremental_freshness_cycle(&db).expect("run incremental Feed cycle");
    let summary = match outcome {
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
            summary
        }
        other => panic!("Apply Feed must be processed, got {other:?}"),
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);

    db.with_conn(|conn| {
        let canonical = canonical_application_freshness(conn, PROJECT_ID, &application_id)?
            .expect("new Application has a canonical Generic row after its Feed cycle");
        assert_eq!(
            canonical.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(canonical.semantic_epoch_id, EPOCH_ID);
        let baseline_after: (Option<String>, String) = conn.query_row(
            "SELECT last_evaluated_run_id, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, APPLICATION_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(baseline_after, baseline_before);
        Ok::<_, anyhow::Error>(())
    })
    .expect("read canonical Generic result and check no unrelated evaluation");

    let restart = run_incremental_freshness_cycle(&db).expect("restart-safe idle cycle");
    assert!(matches!(
        restart,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));
}

#[test]
fn second_temporal_node_ensure_initializes_generic_without_false_feed() {
    let _test_guard = serialize_liveness_test();
    let db = fixture_db();
    db.with_conn(seed_cutover_ready_application)
        .expect("seed all C2-ZA durable prerequisites");
    let evidence = scheduler_heartbeat(&db, "c2zc-temporal-authority", 1);
    db.with_conn(|conn| cut_over_workspace_freshness(conn, &evidence))
        .expect("activate Generic Consumer Freshness");
    enable_manual_apply(&db);

    let first_parts = seed_approved_temporal_node(
        &db,
        "run-c2zc-temporal-first",
        "task-c2zc-temporal-first",
        "set-c2zc-temporal-first",
        "proposal-c2zc-temporal-first",
        "temporal-node-c2zc",
    );
    let first_commit = apply_temporal_node(
        &db,
        &first_parts.0,
        &first_parts.1,
        &first_parts.2,
        &first_parts.3,
        "temporal-node-c2zc",
        "request-c2zc-temporal-first",
    );
    let first_application_id = application_id_for_commit(&db, &first_commit);
    let first_cycle = run_incremental_freshness_cycle(&db).expect("evaluate first node Feed");
    assert!(matches!(
        first_cycle,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(_)
    ));

    let feed_transactions_before_second = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("count Feed transactions before second ensure");
    let first_row_before_second = consumer_freshness_row(&db, &first_application_id);

    let second_parts = seed_approved_temporal_node(
        &db,
        "run-c2zc-temporal-second",
        "task-c2zc-temporal-second",
        "set-c2zc-temporal-second",
        "proposal-c2zc-temporal-second",
        "temporal-node-c2zc",
    );
    let second_commit = apply_temporal_node(
        &db,
        &second_parts.0,
        &second_parts.1,
        &second_parts.2,
        &second_parts.3,
        "temporal-node-c2zc",
        "request-c2zc-temporal-second",
    );
    let second_application_id = application_id_for_commit(&db, &second_commit);
    assert_ne!(first_application_id, second_application_id);
    assert!(
        second_commit.get("maintenanceTransactionId").is_none(),
        "ensure-existing must not fabricate a Change Feed transaction"
    );

    db.with_conn(|conn| {
        let feed_transactions_after_second: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            feed_transactions_after_second, feed_transactions_before_second,
            "second ensure must preserve the no-false-Feed contract"
        );
        let edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, second_application_id],
            |row| row.get(0),
        )?;
        assert_eq!(edge_count, 1, "second ensure declares its Generic Edge");
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify second typed Application declaration");

    let second_edge_before_source = application_edge_freshness_row(&db, &second_application_id);
    assert_eq!(second_edge_before_source.1, "unknown");
    assert_eq!(second_edge_before_source.2, None);
    assert_eq!(second_edge_before_source.3, "manual");
    assert_eq!(second_edge_before_source.4, EPOCH_ID);
    let second_consumer_before_source = consumer_freshness_row(&db, &second_application_id);
    assert_eq!(second_consumer_before_source.0, PROJECT_ID);
    assert_eq!(second_consumer_before_source.1, "application");
    assert_eq!(second_consumer_before_source.2, second_application_id);
    assert_eq!(second_consumer_before_source.3, "unknown");
    assert_eq!(second_consumer_before_source.4, "manual");
    assert_eq!(second_consumer_before_source.5, EPOCH_ID);
    assert_eq!(second_consumer_before_source.6, None);
    assert_eq!(
        second_consumer_before_source.7,
        Some(dependency_set_digest(&[SOURCE_IDENTITY]))
    );

    let next_cycle = run_incremental_freshness_cycle(&db).expect("next cycle is restart-safe");
    assert!(matches!(
        next_cycle,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let canonical = canonical_application_freshness(conn, PROJECT_ID, &second_application_id)?
            .expect("second ensure Application has canonical Generic Freshness");
        assert_eq!(
            canonical.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(canonical.evidence_freshness, "unknown");
        assert_eq!(canonical.build_action, "manual");
        assert_eq!(canonical.semantic_epoch_id, EPOCH_ID);
        assert_eq!(
            canonical.dependency_set_digest,
            Some(dependency_set_digest(&[SOURCE_IDENTITY,]))
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("read second canonical Generic result without unrelated evaluation");

    assert_eq!(
        consumer_freshness_row(&db, &first_application_id),
        first_row_before_second,
        "idempotent ensure must leave the complete unrelated Consumer row byte-for-byte unchanged"
    );

    mutate_scene_source(&db);
    let source_run_id = match run_incremental_freshness_cycle(&db)
        .expect("process real Source mutation through the Feed runtime")
    {
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
            assert!(summary.affected_edge_count >= 1);
            assert!(summary.affected_consumer_count >= 1);
            summary.run_id
        }
        other => panic!("real Source mutation must be processed, got {other:?}"),
    };

    let second_edge_after_source = application_edge_freshness_row(&db, &second_application_id);
    assert_eq!(second_edge_after_source.0, second_edge_before_source.0);
    assert_eq!(second_edge_after_source.1, "stale");
    assert_eq!(
        second_edge_after_source.2.as_deref(),
        Some("source-revision-changed")
    );
    assert_eq!(second_edge_after_source.3, "rebuild-required");
    assert_eq!(second_edge_after_source.4, EPOCH_ID);

    let second_consumer_after_source = consumer_freshness_row(&db, &second_application_id);
    assert_eq!(second_consumer_after_source.0, PROJECT_ID);
    assert_eq!(second_consumer_after_source.1, "application");
    assert_eq!(second_consumer_after_source.2, second_application_id);
    assert_eq!(second_consumer_after_source.3, "stale");
    assert_eq!(second_consumer_after_source.4, "rebuild-required");
    assert_eq!(second_consumer_after_source.5, EPOCH_ID);
    assert_eq!(
        second_consumer_after_source.6.as_deref(),
        Some(source_run_id.as_str())
    );
    assert_eq!(
        second_consumer_after_source.7,
        Some(dependency_set_digest(&[SOURCE_IDENTITY]))
    );
    assert_ne!(
        second_consumer_after_source.3, second_consumer_before_source.3,
        "normal Feed evaluation must replace the seeded Unknown state"
    );
    db.with_conn(|conn| {
        let run_provenance: (String, String, String, Option<String>) = conn.query_row(
            "SELECT project_id, status, semantic_epoch_id, completed_at
               FROM narrative_extraction_runs WHERE id = ?1",
            [source_run_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(run_provenance.0, PROJECT_ID);
        assert_eq!(run_provenance.1, "completed");
        assert_eq!(run_provenance.2, EPOCH_ID);
        assert!(run_provenance.3.is_some());
        Ok::<_, anyhow::Error>(())
    })
    .expect("source Feed run carries completed current-epoch provenance");

    let idle_after_source = run_incremental_freshness_cycle(&db)
        .expect("next cycle after normal source publication is restart-safe");
    assert!(matches!(
        idle_after_source,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));
}
