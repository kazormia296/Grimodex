//! C2-ZC public cutover contract.
//!
//! These tests describe the externally visible boundary. They do not exercise
//! a private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::collections::BTreeMap;
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
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[path = "support/release_schema_fixture.rs"]
mod release_schema_fixture;

const PROJECT_ID: &str = "project-c2zc";
const EPOCH_ID: &str = "epoch-c2zc";
const APPLICATION_ID: &str = "application-c2zc";
const SOURCE_IDENTITY: &str = "project:scene:scene-c2zc";
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
) -> (String, String, String, String, String) {
    let run_id = "run-c2zc-previous-release";
    let task_id = "task-c2zc-previous-release";
    let set_id = "set-c2zc-previous-release";
    let proposal_id = "proposal-c2zc-previous-release";
    let event_id = "event-c2zc-previous-release";
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: project_id.to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-c2zc-previous-release".to_string(),
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
                    event_id,
                    scene_id,
                    "C2-ZC previous-release event",
                ),
                reconciliation_envelope: Some(prepared_envelope_for(
                    source_identity,
                    revision_token,
                    run_id,
                    task_id,
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
            created_by: Some("c2zc-upgrade-test".to_string()),
        },
    )
    .expect("approve previous-release application proposal");
    (
        run_id.to_string(),
        set_id.to_string(),
        saved_proposal_id,
        revision_id,
        event_id.to_string(),
    )
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
) -> String {
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: project_id.to_string(),
            run_id: run_id.to_string(),
            proposal_set_id: set_id.to_string(),
            request_id: "request-c2zc-previous-release".to_string(),
            plan_digest: "client-digest-ignored".to_string(),
            session_id: "session-c2zc-previous-release".to_string(),
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
            expected_tail_ordinal: Some("a0".to_string()),
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
            request_id: "request-c2zc-previous-release".to_string(),
            session_id: "session-c2zc-previous-release".to_string(),
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

fn assert_clean_verify_evidence(
    db: &Database,
    outcome: &grimodex_db::narrative_extraction::VerifyRunOutcome,
    expected_epoch_id: &str,
) {
    assert!(
        !outcome.run_id.trim().is_empty(),
        "Verify Run ID must be present"
    );
    assert_eq!(outcome.semantic_epoch_id, expected_epoch_id);
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
        project_ids.contains(&release_schema_fixture::PROJECT_ID.to_string()),
        "migrated release project must remain present"
    );

    // The previous release has no current C2-ZC Application Graph. Create one
    // through the public proposal/review/apply path while the legacy mirror is
    // still authoritative; the real Backfill below then imports that legacy
    // dependency into the current Graph.
    enable_manual_apply_preserving_flags(&opened.database);
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
    );
    assert!(
        !application_id.trim().is_empty(),
        "Application ID must be returned"
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
            }
            | grimodex_db::narrative_extraction::LegacyBackfillBootstrapOutcome::AlreadyRun {
                run_id,
            } => run_id,
        };
        assert!(
            !run_id.trim().is_empty(),
            "Backfill Run ID must be returned"
        );
        backfill_run_ids.insert(project_id.clone(), run_id);
    }
    let migrated_edge_count = opened
        .database
        .with_conn(|conn| {
            Ok::<_, anyhow::Error>(conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_dependency_edges
                  WHERE project_id = ?1 AND consumer_kind = 'application'
                    AND consumer_key = ?2",
                params![release_schema_fixture::PROJECT_ID, application_id],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("count Backfill-produced Application Edges");
    assert_eq!(
        migrated_edge_count, 1,
        "Backfill must import the legacy dependency exactly once"
    );

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
        project_ids.len(),
        "one current Epoch per migrated project"
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
    for project_id in &project_ids {
        assert!(
            epoch_by_project.contains_key(project_id),
            "current Epoch binding missing for project {project_id}"
        );
    }

    // First Verify is a real current-Epoch diagnostic. Rebuild is still
    // deliberately absent at this point, so durable readiness must remain
    // incomplete rather than treating migration/backfill as cutover proof.
    let mut initial_verify_run_ids = BTreeMap::new();
    for project_id in &project_ids {
        let verify = run_dependency_verify_for_project(&opened.database, project_id)
            .expect("run production initial current-Epoch Verify");
        assert_eq!(
            verify.semantic_epoch_id, epoch_by_project[project_id],
            "initial Verify must bind to the project's current Epoch"
        );
        initial_verify_run_ids.insert(project_id.clone(), verify.run_id);
    }
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
        rebuild_run_ids.insert(project_id.clone(), run_id);
    }

    let mut confirmation_verify_run_ids = BTreeMap::new();
    let mut confirmation_verify_outcomes = BTreeMap::new();
    for project_id in &project_ids {
        let verify = run_dependency_verify_for_project(&opened.database, project_id)
            .expect("run production confirmation current-Epoch Verify");
        assert_clean_verify_evidence(&opened.database, &verify, &epoch_by_project[project_id]);
        confirmation_verify_run_ids.insert(project_id.clone(), verify.run_id.clone());
        confirmation_verify_outcomes.insert(project_id.clone(), verify);
    }

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

    let readiness = opened
        .database
        .with_conn(|conn| inspect_workspace_cutover_readiness_with_liveness(conn, Some(&evidence)))
        .expect("read final C2-ZC readiness");
    assert_eq!(readiness.state, ReadinessState::Passed);
    assert!(readiness.ready, "final readiness must pass: {readiness:?}");
    assert_eq!(readiness.durable.projects.len(), project_ids.len());
    for project in &readiness.durable.projects {
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
                .get(&project.project_id)
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

    let canonical_before = opened
        .database
        .with_conn(|conn| {
            canonical_application_freshness(
                conn,
                release_schema_fixture::PROJECT_ID,
                &application_id,
            )
        })
        .expect("read Generic canonical Application Freshness after cutover")
        .expect("migrated Application must have Generic Freshness");
    assert_eq!(
        canonical_before.authority,
        CanonicalFreshnessAuthority::GenericConsumerFreshness
    );
    assert_eq!(
        canonical_before.semantic_epoch_id,
        epoch_by_project[release_schema_fixture::PROJECT_ID]
    );
    assert_eq!(canonical_before.evidence_freshness, "fresh");
    assert_eq!(canonical_before.build_action, "none");
    assert_eq!(
        canonical_before.last_evaluated_run_id.as_deref(),
        Some(rebuild_run_ids[release_schema_fixture::PROJECT_ID].as_str())
    );

    let persistence_before_reopen = read_c2zc_persistence_counts(&opened.database);
    assert_eq!(
        persistence_before_reopen.0, 1,
        "exactly one C2-ZC marker is allowed"
    );

    // Corrupt only the compatibility projection after cutover. The canonical
    // reread must continue to return the Generic row, proving no legacy
    // fallback or authority weakening.
    let canonical_after_legacy_mutation = opened
        .database
        .with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_projection_freshness
                    SET status = 'source-missing'
                  WHERE application_id = ?1",
                [&application_id],
            )?;
            canonical_application_freshness(
                conn,
                release_schema_fixture::PROJECT_ID,
                &application_id,
            )
        })
        .expect("read canonical Generic row after legacy compatibility mutation")
        .expect("Generic canonical row must remain available");
    assert_eq!(canonical_after_legacy_mutation, canonical_before);

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
    let canonical_after_reopen = reopened
        .database
        .with_conn(|conn| {
            canonical_application_freshness(
                conn,
                release_schema_fixture::PROJECT_ID,
                &application_id,
            )
        })
        .expect("read canonical Generic row after supervisor reopen")
        .expect("Generic canonical row must survive supervisor reopen");
    assert_eq!(canonical_after_reopen, canonical_before);
    release_schema_fixture::assert_release_fixture_rows(&db_path);

    let epoch_counts_unchanged = persistence_after_reopen.1 == persistence_before_reopen.1;
    let authority_counts_unchanged = persistence_after_reopen.2 == persistence_before_reopen.2;
    assert!(epoch_counts_unchanged);
    assert!(authority_counts_unchanged);
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
        "legacyRowsExact": true,
        "phases": {
            "backfillRunIds": backfill_run_ids,
            "initialVerifyRunIds": initial_verify_run_ids,
            "rebuildRunIds": rebuild_run_ids,
            "confirmationVerifyRunIds": confirmation_verify_run_ids,
        },
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
            "authority": canonical_after_reopen.authority,
            "applicationId": application_id,
            "semanticEpochId": canonical_after_reopen.semantic_epoch_id,
            "legacyMutationIgnored": canonical_after_legacy_mutation == canonical_before
                && canonical_after_reopen == canonical_before,
            "lastEvaluatedRunId": canonical_after_reopen.last_evaluated_run_id,
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
