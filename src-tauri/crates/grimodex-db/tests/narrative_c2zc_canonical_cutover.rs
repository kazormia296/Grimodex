//! C2-ZC public cutover contract (RED on the frozen C2-ZB base).
//!
//! These tests intentionally describe the externally visible boundary before
//! the canonical-authority implementation exists.  They do not exercise a
//! private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::path::Path;
use std::sync::{Mutex, OnceLock};

use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::maintenance_skip_evidence::{
    durable_graph_state_digest, persist_completed_run_skip_evidence_in_tx, CompletedRunSkipEvidence,
};
use grimodex_db::narrative_extraction::{
    canonical_application_freshness, current_maintenance_coordinates, cut_over_workspace_freshness,
    digest_plan, ensure_test_schema, inspect_workspace_cutover_readiness_with_liveness,
    narrative_extraction_append_human_decision, narrative_extraction_apply_commit,
    narrative_extraction_create_run, narrative_extraction_prepare_commit,
    narrative_extraction_save_proposal_set, record_live_scheduler_heartbeat,
    run_incremental_freshness_cycle, verify_narrative_dependency_graph_for_project,
    AppendDecisionPayload, ApplyCommitPayload, CanonicalFreshnessAuthority, CommitApplicationRef,
    CommitOperation, CreateRunPayload, CreateTaskSeed, PrepareCommitPayload, ProposalSeed,
    ReadinessState, SaveProposalSetPayload, SchedulerLivenessEvidence, C2_ZC_CUTOVER_MIGRATION_ID,
    REBUILD_DERIVED_WORK_KEY, REQUIRED_VERIFY_CHECKS, VERIFY_RUN_KIND_CONTRACT_VERSION,
    VERIFY_WORK_KEY_PREFIX,
};
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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
        scheduler_instance_id: "scheduler-c2zc-red".to_string(),
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
        // The RED fixture deliberately calls the public cutover API only
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
        Some(BASELINE_FRESHNESS_RUN_ID),
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
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at)
         VALUES ('commit-c2zc', ?1, ?2, 'request-c2zc', 'sha256:c2zc',
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

    // The sealed Verify evidence must be the live graph's own report: the
    // cutover now runs the same skip-evidence CAS an ordinary maintenance
    // wake uses, so fabricated default-report JSON no longer passes.
    let live_report = verify_narrative_dependency_graph_for_project(conn, PROJECT_ID)?;
    anyhow::ensure!(
        live_report.is_clean(),
        "fixture graph must verify clean: {live_report:?}"
    );
    let report = serde_json::to_value(&live_report)?;
    let check_coverage = json!({
        "complete": true,
        "required": REQUIRED_VERIFY_CHECKS,
        "covered": REQUIRED_VERIFY_CHECKS,
        "missing": [],
    });
    let verify_spec = json!({ "verifyContractVersion": VERIFY_RUN_KIND_CONTRACT_VERSION });
    let verify_spec_json = verify_spec.to_string();
    let graph_state_digest = durable_graph_state_digest(conn, PROJECT_ID)?;
    let verify_outcome = json!({
        "verifyContractVersion": VERIFY_RUN_KIND_CONTRACT_VERSION,
        "semanticEpochId": EPOCH_ID,
        "graphStateDigest": graph_state_digest.clone(),
        "reportDigest": format!("sha256:{}", digest_plan(&report)),
        "report": report,
        "checkCoverage": check_coverage,
    });
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
        "consumersEvaluated": 1,
        "edgesEvaluated": 1,
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

    let incremental_outcome = json!({
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
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'freshness-c2zc', 'completed',
                 '{}', ?3, ?4, ?4, ?4, 'freshness-evaluation', ?5, ?6,
                 'narrative-incremental-freshness/v1')",
        params![
            BASELINE_FRESHNESS_RUN_ID,
            PROJECT_ID,
            incremental_outcome.to_string(),
            NOW,
            EPOCH_ID,
            format!("incremental-freshness:{EPOCH_ID}:0:0:baseline")
        ],
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

fn prepared_event_payload() -> Value {
    json!({
        "eventId": "event-c2zc-prepared",
        "title": "C2-ZC prepared event",
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": "scene-c2zc",
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

fn prepared_envelope(run_id: &str, task_id: &str) -> Value {
    let revision_token = format!("v0@{NOW}");
    let read_set = json!([{
        "inputRef": SOURCE_IDENTITY,
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
            "sourceKey": SOURCE_IDENTITY,
            "revisionToken": format!("v0@{NOW}"),
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", digest_plan(&json!([{
            "inputRef": SOURCE_IDENTITY,
            "kind": "snapshot-document",
            "sourceKind": "scene-body",
            "revisionToken": format!("v0@{NOW}"),
        }]))),
        "changeKind": "add"
    })
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
