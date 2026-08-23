//! RED-first C2-5B integration coverage for the Run/Task/Attempt owner.
//!
//! The accepted foreground runtime already dispatches the three automatic
//! phases and can hold/release a marked Run.  These tests pin the missing
//! lifecycle contract at that boundary: every phase owns one Task and one
//! Attempt, foreground success holds all three rows, and recovery preserves
//! exact Attempt failure metadata.

use grimodex_db::narrative_extraction::digest_plan;
use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    complete_foreground_system_work_run, find_running_foreground_system_work_run,
    run_system_work_cycle, run_system_work_cycle_with_modes_and_config,
    run_system_work_cycle_with_modes_and_config_and_foreground_owner,
    terminalize_interrupted_runs_for_epoch, AutomaticRunKind, MaintenanceCycleRequest,
    MaintenanceCycleStatus, MaintenanceWorkspaceBinding, NarrativeMaintenanceCiConfig,
    NarrativeMaintenanceCiTrigger, RecoveryMode, WorkKey, LEGACY_BACKFILL_WORK_KEY,
    REBUILD_DERIVED_WORK_KEY, VERIFY_WORK_KEY_PREFIX,
};
use grimodex_db::narrative_extraction::{
    current_maintenance_coordinates, evaluate_completed_run_skip,
    run_dependency_verify_for_project, CompletedRunSkipDecision, CompletedRunSkipExpectation,
    REBUILD_RUN_KIND_CONTRACT_VERSION, VERIFY_RUN_KIND_CONTRACT_VERSION,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-lifecycle";
const EPOCH_ID: &str = "epoch-c2-5b-lifecycle";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B lifecycle')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', '2026-08-23T00:00:00.000Z')",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed lifecycle fixture");
    db
}

fn fixture_db_without_epoch() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B lifecycle')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed lifecycle fixture without epoch");
    db
}

fn foreground_config() -> NarrativeMaintenanceCiConfig {
    NarrativeMaintenanceCiConfig {
        is_packaged: false,
        ci: "true".to_string(),
        owner_token: "c2-5b-product-journey-owner-v1".to_string(),
        fault: None,
        trigger: Some(NarrativeMaintenanceCiTrigger::ForegroundWorkspaceWake),
        setup: None,
        product_journey_barrier_id: Some("barrier-c2-5b-lifecycle".to_string()),
        correlation: Some("correlation-c2-5b-lifecycle".to_string()),
    }
}

fn request(run_kind: AutomaticRunKind) -> MaintenanceCycleRequest {
    let (work_key, semantic_epoch_id) = match run_kind {
        AutomaticRunKind::Backfill => (LEGACY_BACKFILL_WORK_KEY, None),
        AutomaticRunKind::Verify => (VERIFY_WORK_KEY_PREFIX, Some(EPOCH_ID)),
        AutomaticRunKind::RebuildDerived => (REBUILD_DERIVED_WORK_KEY, Some(EPOCH_ID)),
    };
    let work_key = if run_kind == AutomaticRunKind::Verify {
        format!("{work_key}{EPOCH_ID}")
    } else {
        work_key.to_string()
    };
    serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": run_kind,
            "workKey": work_key,
            "semanticEpochId": semantic_epoch_id,
            "reasons": ["lifecycle-integration"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid maintenance request")
}

fn lifecycle_rows_for_run(
    db: &Database,
    run_id: &str,
) -> anyhow::Result<(
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT r.status, t.status, a.status,
                    r.completed_at, t.completed_at, a.completed_at
               FROM narrative_extraction_runs r
               JOIN narrative_extraction_tasks t ON t.run_id = r.id
               JOIN narrative_extraction_attempts a ON a.task_id = t.id
              WHERE r.id = ?1",
            [run_id],
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
        )
        .map_err(Into::into)
    })
}

fn outcome_for_run(db: &Database, run_id: &str) -> anyhow::Result<Option<String>> {
    db.with_conn(|conn| {
        conn.query_row(
            "SELECT outcome_summary_json
               FROM narrative_extraction_runs
              WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
}

fn seed_completed_backfill(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('lifecycle-backfill-completed', ?1, 'maintenance', '{}',
                     '{\"backfillAlgorithmVersion\":\"3\"}', 'digest',
                     'completed', '{}', '2026-08-21T00:00:00.000Z',
                     '2026-08-21T00:00:01.000Z',
                     '{\"maintenancePhase\":\"backfill-complete\",\"backfillAlgorithmVersion\":\"3\",\"semanticEpochId\":\"epoch-c2-5b-lifecycle\",\"summary\":{\"epoch_created\":false,\"contributions_created\":0,\"edges_created\":0,\"applications_without_run_id\":0}}',
                     'backfill', ?2, 'legacy-dependency-backfill:v3')",
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed completed Backfill boundary");
}

fn seed_completed_rebuild(db: &Database) {
    let summary = json!({
        "consumersEvaluated": 0,
        "edgesEvaluated": 0,
        "consumersSkippedUnresolvableScope": 0,
        "edgesSkippedUnresolvableScope": 0
    });
    let outcome = json!({
        "rebuildContractVersion": "0",
        "semanticEpochId": EPOCH_ID,
        "summaryDigest": format!("sha256:{}", digest_plan(&summary)),
        "summary": summary
    });
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('lifecycle-rebuild-stale', ?1, 'maintenance', '{}', '{}', 'digest',
                     'completed', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z', ?2, 'semantic-index-rebuild', ?3,
                     'dependency-rebuild-derived')",
            params![PROJECT_ID, outcome.to_string(), EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed stale completed Rebuild");
}

#[test]
fn automatic_success_owns_exactly_one_task_and_attempt_and_finalizes_atomically() {
    for run_kind in AutomaticRunKind::all() {
        let db = fixture_db();
        if run_kind == AutomaticRunKind::Verify {
            seed_completed_backfill(&db);
        }
        run_system_work_cycle(&db, &request(run_kind), RecoveryMode::SameProcessLive)
            .expect("automatic phase succeeds");

        let rows: Vec<(String, String, String, String, String, String)> = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT r.status, t.status, a.status,
                            r.completed_at, t.completed_at, a.completed_at
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.project_id = ?1 AND r.run_kind = ?2",
                )?;
                let rows = statement
                    .query_map(params![PROJECT_ID, run_kind.as_str()], |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read automatic lifecycle");
        assert_eq!(rows.len(), 1, "one lifecycle pair belongs to each phase");
        let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) = &rows[0];
        assert_eq!(run_status, "completed");
        assert_eq!(task_status, "completed");
        assert_eq!(attempt_status, "completed");
        assert_eq!(run_at, task_at);
        assert_eq!(task_at, attempt_at);
    }
}

#[test]
fn foreground_success_holds_all_three_rows_then_exact_release_shares_one_timestamp() {
    let db = fixture_db();
    let binding = MaintenanceWorkspaceBinding {
        authority_id: "authority-c2-5b-lifecycle".to_string(),
        generation: 17,
    };
    let config = foreground_config();
    let mut foreground_request = request(AutomaticRunKind::RebuildDerived);
    foreground_request.workspace_binding = Some(binding.clone());

    let result = run_system_work_cycle_with_modes_and_config(
        &db,
        &foreground_request,
        |_| RecoveryMode::SameProcessLive,
        Some(&config),
    )
    .expect("foreground phase succeeds");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);

    let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
        .expect("find exact foreground Run")
        .expect("foreground Run remains held");
    let held = lifecycle_rows_for_run(&db, &barrier.run_id);
    assert!(held.is_ok(), "held Run must own Task and Attempt");
    let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) =
        held.expect("read held lifecycle");
    assert_eq!(
        (
            run_status.as_str(),
            task_status.as_str(),
            attempt_status.as_str()
        ),
        ("running", "running", "running")
    );
    assert_eq!((run_at, task_at, attempt_at), (None, None, None));

    complete_foreground_system_work_run(&db, &barrier).expect("release exact foreground Run");
    let released = lifecycle_rows_for_run(&db, &barrier.run_id).expect("read released lifecycle");
    let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) = released;
    assert_eq!(
        (
            run_status.as_str(),
            task_status.as_str(),
            attempt_status.as_str()
        ),
        ("completed", "completed", "completed")
    );
    assert!(run_at.is_some());
    assert_eq!(run_at, task_at);
    assert_eq!(task_at, attempt_at);

    complete_foreground_system_work_run(&db, &barrier)
        .expect("an exact completed lifecycle release remains idempotent");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_attempts
                SET status = 'failed'
              WHERE task_id IN (
                    SELECT id FROM narrative_extraction_tasks WHERE run_id = ?1
              )",
            [barrier.run_id.as_str()],
        )?;
        Ok(())
    })
    .expect("corrupt the completed child lifecycle");
    assert!(
        complete_foreground_system_work_run(&db, &barrier).is_err(),
        "duplicate release must validate the completed Task/Attempt pair"
    );
}

#[test]
fn foreground_backfill_stays_running_when_same_cycle_rediscovery_binds_epoch() {
    let db = fixture_db_without_epoch();
    let binding = MaintenanceWorkspaceBinding {
        authority_id: "authority-c2-5b-lifecycle-backfill".to_string(),
        generation: 19,
    };
    let config = foreground_config();
    let mut foreground_request = request(AutomaticRunKind::Backfill);
    foreground_request.workspace_binding = Some(binding.clone());

    // The first Backfill creates the initial Semantic Epoch. Its durable
    // rediscovery therefore has an epoch-bound WorkKey even though the exact
    // marked Run's immutable foreground marker is intentionally epochless.
    // StartupRecovery must not mistake that same marked Run for a pre-existing
    // interrupted Run before the N-API cycle has returned its ACK.
    let result = run_system_work_cycle_with_modes_and_config(
        &db,
        &foreground_request,
        |_| RecoveryMode::StartupRecovery,
        Some(&config),
    )
    .expect("foreground Backfill cycle succeeds");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);

    let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
        .expect("find exact foreground Backfill")
        .expect("the marked Backfill must remain held after same-cycle rediscovery");
    assert_eq!(
        barrier.marker.canonical_work_key,
        "narrative-maintenance:v1/backfill/project-c2-5b-lifecycle/legacy-dependency-backfill:v3"
    );
    let (run_status, task_status, attempt_status, run_at, task_at, attempt_at) =
        lifecycle_rows_for_run(&db, &barrier.run_id).expect("read held Backfill lifecycle");
    assert_eq!(
        (
            run_status.as_str(),
            task_status.as_str(),
            attempt_status.as_str()
        ),
        ("running", "running", "running")
    );
    assert_eq!((run_at, task_at, attempt_at), (None, None, None));

    complete_foreground_system_work_run(&db, &barrier)
        .expect("release exact foreground Backfill after authoring");
    assert_eq!(
        lifecycle_rows_for_run(&db, &barrier.run_id)
            .expect("read released Backfill lifecycle")
            .0,
        "completed"
    );
}

#[test]
fn foreground_backfill_stays_running_across_followup_cycle_only_for_exact_owner() {
    let db = fixture_db_without_epoch();
    let binding = MaintenanceWorkspaceBinding {
        authority_id: "authority-c2-5b-lifecycle-followup".to_string(),
        generation: 23,
    };
    let config = foreground_config();
    let mut foreground_request = request(AutomaticRunKind::Backfill);
    foreground_request.workspace_binding = Some(binding.clone());

    let first = run_system_work_cycle_with_modes_and_config(
        &db,
        &foreground_request,
        |_| RecoveryMode::StartupRecovery,
        Some(&config),
    )
    .expect("first foreground Backfill cycle succeeds");
    assert_eq!(first.status, MaintenanceCycleStatus::Accepted);
    let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
        .expect("find exact foreground owner")
        .expect("first cycle must leave one held Run");

    let followup = MaintenanceCycleRequest {
        work: Vec::new(),
        wake_project_ids: vec![PROJECT_ID.to_string()],
        workspace_binding: Some(binding.clone()),
    };
    let second = run_system_work_cycle_with_modes_and_config_and_foreground_owner(
        &db,
        &followup,
        |_| RecoveryMode::StartupRecovery,
        Some(&config),
        Some(&barrier),
    )
    .expect("same-process follow-up keeps the exact owner held");
    assert_eq!(second.status, MaintenanceCycleStatus::Accepted);

    let rows: Vec<(String, String, Option<String>)> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, status, terminal_reason_code
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill'
                  ORDER BY created_at, id",
            )?;
            let rows = statement
                .query_map([PROJECT_ID], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read follow-up Backfill ledger");
    assert_eq!(rows.len(), 1, "follow-up must not replace the held Run");
    assert_eq!(rows[0].0, barrier.run_id);
    assert_eq!(rows[0].1, "running");
    assert_eq!(rows[0].2, None);

    complete_foreground_system_work_run(&db, &barrier)
        .expect("release exact owner after the follow-up cycle");
}

#[test]
fn foreground_explicit_verify_holds_rebuild_before_confirmation_without_overlap() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    seed_completed_rebuild(&db);
    run_dependency_verify_for_project(&db, PROJECT_ID)
        .expect("current Verify must seal skip evidence before foreground dispatch");

    let binding = MaintenanceWorkspaceBinding {
        authority_id: "authority-c2-5b-lifecycle-rebuild-first".to_string(),
        generation: 18,
    };
    let config = foreground_config();
    let mut foreground_request = request(AutomaticRunKind::Verify);
    foreground_request.workspace_binding = Some(binding.clone());

    run_system_work_cycle_with_modes_and_config(
        &db,
        &foreground_request,
        |_| RecoveryMode::SameProcessLive,
        Some(&config),
    )
    .expect("foreground explicit Verify must hold the queued Rebuild");

    let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
        .expect("find exact foreground Rebuild")
        .expect("Rebuild must be the first held phase");
    let held_identity: (String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id, run_kind, work_key
                   FROM narrative_extraction_runs
                  WHERE id = ?1",
                [barrier.run_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read exact held Run identity");
    assert_eq!(
        held_identity,
        (
            barrier.run_id.clone(),
            AutomaticRunKind::RebuildDerived.as_str().to_string(),
            REBUILD_DERIVED_WORK_KEY.to_string(),
        ),
        "the foreground barrier must own the queued Rebuild Run exactly"
    );

    let active_kinds: Vec<String> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT run_kind
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND status IN ('pending', 'running')
                  ORDER BY run_kind",
            )?;
            let rows = statement
                .query_map([PROJECT_ID], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read active foreground phases");
    assert_eq!(
        active_kinds,
        vec![AutomaticRunKind::RebuildDerived.as_str().to_string()],
        "foreground Verify/Rebuild phases must never overlap"
    );

    complete_foreground_system_work_run(&db, &barrier)
        .expect("release the exact held Rebuild before confirmation Verify");
    run_system_work_cycle(
        &db,
        &request(AutomaticRunKind::Verify),
        RecoveryMode::SameProcessLive,
    )
    .expect("confirmation Verify must proceed after Rebuild release");

    let (verify_count, rebuild_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read released foreground phase sequence");
    assert_eq!(
        verify_count, 2,
        "one seeded Verify plus one confirmation Verify"
    );
    assert_eq!(
        rebuild_count, 2,
        "one stale Rebuild plus one repaired Rebuild"
    );
}

#[test]
fn completed_foreground_duplicate_validates_phase_outcome_before_idempotency() {
    for run_kind in AutomaticRunKind::all() {
        for tamper in ["null", "empty", "wrong-coordinate-or-digest"] {
            let db = if run_kind == AutomaticRunKind::Backfill {
                fixture_db_without_epoch()
            } else {
                fixture_db()
            };
            let binding = MaintenanceWorkspaceBinding {
                authority_id: "authority-c2-5b-lifecycle".to_string(),
                generation: 17,
            };
            let config = foreground_config();
            let mut foreground_request = request(run_kind);
            foreground_request.workspace_binding = Some(binding.clone());
            run_system_work_cycle_with_modes_and_config(
                &db,
                &foreground_request,
                |_| RecoveryMode::SameProcessLive,
                Some(&config),
            )
            .expect("foreground phase succeeds before completed duplicate test");
            let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
                .expect("find exact foreground Run")
                .expect("foreground Run remains held");
            complete_foreground_system_work_run(&db, &barrier)
                .expect("first release accepts the native phase outcome");
            let lifecycle_before_tamper =
                lifecycle_rows_for_run(&db, &barrier.run_id).expect("read completed lifecycle");
            assert_eq!(
                (
                    lifecycle_before_tamper.0.as_str(),
                    lifecycle_before_tamper.1.as_str(),
                    lifecycle_before_tamper.2.as_str(),
                ),
                ("completed", "completed", "completed")
            );
            let original_outcome = outcome_for_run(&db, &barrier.run_id)
                .expect("read completed outcome")
                .expect("completed release records an outcome");
            let tampered_outcome = match tamper {
                "null" => None,
                "empty" => Some("{}".to_string()),
                "wrong-coordinate-or-digest" => {
                    let mut outcome: serde_json::Value =
                        serde_json::from_str(&original_outcome).expect("parse native outcome");
                    match run_kind {
                        AutomaticRunKind::Backfill => {
                            outcome["semanticEpochId"] = json!("tampered-epoch");
                        }
                        AutomaticRunKind::Verify => {
                            outcome["reportDigest"] = json!("sha256:tampered");
                        }
                        AutomaticRunKind::RebuildDerived => {
                            outcome["summaryDigest"] = json!("sha256:tampered");
                        }
                    }
                    Some(outcome.to_string())
                }
                other => unreachable!("unknown completed outcome tamper {other}"),
            };
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET outcome_summary_json = ?1
                      WHERE id = ?2",
                    params![tampered_outcome, barrier.run_id],
                )?;
                Ok(())
            })
            .expect("tamper completed phase outcome");

            assert!(
                complete_foreground_system_work_run(&db, &barrier).is_err(),
                "completed duplicate must reject {tamper} outcome for {:?}",
                run_kind
            );
            let lifecycle_after_duplicate =
                lifecycle_rows_for_run(&db, &barrier.run_id).expect("read lifecycle after reject");
            assert_eq!(
                lifecycle_after_duplicate, lifecycle_before_tamper,
                "rejected duplicate must not mutate any lifecycle timestamp/status"
            );
            assert_eq!(
                outcome_for_run(&db, &barrier.run_id).expect("read outcome after reject"),
                tampered_outcome,
                "rejected duplicate must not repair or overwrite tampered evidence"
            );

            if run_kind == AutomaticRunKind::Verify {
                let coordinates =
                    current_maintenance_coordinates().expect("read current contract coordinates");
                let expected = CompletedRunSkipExpectation {
                    project_id: PROJECT_ID.to_string(),
                    run_kind: AutomaticRunKind::Verify.as_str().to_string(),
                    work_key: format!("{VERIFY_WORK_KEY_PREFIX}{EPOCH_ID}"),
                    semantic_epoch_id: EPOCH_ID.to_string(),
                    graph_contract_digest: coordinates.graph_contract_digest,
                    rule_registry_digest: coordinates.rule_registry_digest,
                    producer_generation_set_digest: coordinates.producer_generation_set_digest,
                    rebuild_contract_version: REBUILD_RUN_KIND_CONTRACT_VERSION.to_string(),
                    run_kind_contract_version: VERIFY_RUN_KIND_CONTRACT_VERSION.to_string(),
                    report_digest: None,
                };
                let decision = db
                    .with_conn(|conn| evaluate_completed_run_skip(conn, &expected))
                    .expect("evaluate tampered completed Verify for rediscovery");
                assert!(
                    matches!(decision, CompletedRunSkipDecision::Rerun { .. }),
                    "partial/tampered completed Verify outcome must never be reused: {decision:?}"
                );
            }
        }
    }
}

#[test]
fn foreground_release_rejects_null_partial_and_wrong_epoch_success_outcomes() {
    for (run_kind, tampered_outcomes) in [
        (
            AutomaticRunKind::Backfill,
            vec![
                None,
                Some(json!({
                    "maintenancePhase": "backfill-complete",
                    "backfillAlgorithmVersion": "2",
                    "semanticEpochId": "wrong-epoch"
                })),
                Some(json!({
                    "maintenancePhase": "backfill-complete",
                    "backfillAlgorithmVersion": "2",
                    "semanticEpochId": "wrong-epoch",
                    "summary": {
                        "epoch_created": false,
                        "contributions_created": 0,
                        "edges_created": 0,
                        "applications_without_run_id": 0
                    }
                })),
            ],
        ),
        (
            AutomaticRunKind::Verify,
            vec![
                None,
                Some(json!({
                    "verifyContractVersion": "7",
                    "semanticEpochId": EPOCH_ID
                })),
                Some(json!({
                    "verifyContractVersion": "7",
                    "semanticEpochId": "wrong-epoch",
                    "report": {},
                    "reportDigest": "sha256:tampered"
                })),
            ],
        ),
        (
            AutomaticRunKind::RebuildDerived,
            vec![
                None,
                Some(json!({
                    "rebuildContractVersion": "1",
                    "semanticEpochId": EPOCH_ID
                })),
                Some(json!({
                    "rebuildContractVersion": "1",
                    "semanticEpochId": "wrong-epoch",
                    "summary": {},
                    "summaryDigest": "sha256:tampered"
                })),
            ],
        ),
    ] {
        for tampered_outcome in tampered_outcomes {
            let db = if run_kind == AutomaticRunKind::Backfill {
                fixture_db_without_epoch()
            } else {
                fixture_db()
            };
            let binding = MaintenanceWorkspaceBinding {
                authority_id: "authority-c2-5b-lifecycle".to_string(),
                generation: 17,
            };
            let config = foreground_config();
            let mut foreground_request = request(run_kind);
            foreground_request.workspace_binding = Some(binding.clone());
            run_system_work_cycle_with_modes_and_config(
                &db,
                &foreground_request,
                |_| RecoveryMode::SameProcessLive,
                Some(&config),
            )
            .expect("foreground phase succeeds before outcome tampering");
            let barrier = find_running_foreground_system_work_run(&db, &config, &binding)
                .expect("find exact foreground Run")
                .expect("foreground Run remains held");
            db.with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                    SET outcome_summary_json = ?1
                  WHERE id = ?2",
                    params![
                        tampered_outcome.as_ref().map(serde_json::Value::to_string),
                        barrier.run_id
                    ],
                )?;
                Ok(())
            })
            .expect("tamper phase outcome");
            assert!(
                complete_foreground_system_work_run(&db, &barrier).is_err(),
                "phase-specific success outcome must be required for {:?}",
                run_kind
            );
            let statuses: (String, String, String) = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT r.status, t.status, a.status
                       FROM narrative_extraction_runs r
                       JOIN narrative_extraction_tasks t ON t.run_id = r.id
                       JOIN narrative_extraction_attempts a ON a.task_id = t.id
                      WHERE r.id = ?1",
                        [&barrier.run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(Into::into)
                })
                .expect("read lifecycle after rejected outcome");
            assert_eq!(
                statuses,
                (
                    "running".to_string(),
                    "running".to_string(),
                    "running".to_string()
                )
            );
        }
    }
}

#[test]
fn startup_interruption_fails_the_exact_attempt_and_preserves_failure_metadata() {
    let db = fixture_db();
    let work = WorkKey::new_for_epoch(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
        EPOCH_ID,
    )
    .expect("valid recovery work key");
    let spec = r#"{"backfillAlgorithmVersion":"3"}"#;
    let spec_digest = format!(
        "sha256:{}",
        digest_plan(&json!({ "backfillAlgorithmVersion": "3" }))
    );
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('interrupted-lifecycle-run', ?1, 'maintenance', '{}', ?2,
                     ?3, 'running', '{}', ?4, ?4,
                     'backfill', ?5, ?6)",
            params![
                PROJECT_ID,
                spec,
                spec_digest,
                "2026-08-23T00:00:00.000Z",
                EPOCH_ID,
                LEGACY_BACKFILL_WORK_KEY
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority, attempt_count,
                 created_at, started_at, version)
             VALUES ('interrupted-lifecycle-task', 'interrupted-lifecycle-run',
                     'maintenance-backfill', 'running', ?1, 0, 1, ?2, ?2, 0)",
            params![spec, "2026-08-23T00:00:00.000Z"],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES ('interrupted-lifecycle-attempt', 'interrupted-lifecycle-task',
                     1, 'running', ?1)",
            ["2026-08-23T00:00:00.000Z"],
        )?;
        Ok(())
    })
    .expect("seed interrupted lifecycle");

    let result = grimodex_db::narrative_extraction::maintenance_runtime::terminalize_interrupted_runs_for_epoch(
        &db,
        PROJECT_ID,
        &work,
        Some(EPOCH_ID),
        &["interrupted-lifecycle-run".to_string()],
    )
    .expect("startup recovery terminalizes all lifecycle rows");
    assert_eq!(result.failed_run_ids, ["interrupted-lifecycle-run"]);

    let metadata: (
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT r.status, t.status, a.status,
                        r.completed_at, t.completed_at, a.completed_at,
                        a.error_message, a.failure_code, a.retry_disposition,
                        a.next_attempt_at
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = 'interrupted-lifecycle-run'",
                [],
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
            )
            .map_err(Into::into)
        })
        .expect("read interrupted lifecycle metadata");
    assert_eq!(
        (&metadata.0, &metadata.1, &metadata.2),
        (
            &"failed".to_string(),
            &"failed".to_string(),
            &"failed".to_string()
        )
    );
    assert!(metadata.3.is_some());
    assert_eq!(metadata.3, metadata.4);
    assert_eq!(metadata.4, metadata.5);
    assert_eq!(metadata.5, metadata.9);
    assert_eq!(
        metadata.6.as_deref(),
        Some("NEX_MAINTENANCE_INTERRUPTED: process interruption")
    );
    assert_eq!(metadata.7.as_deref(), Some("NEX_MAINTENANCE_INTERRUPTED"));
    assert_eq!(metadata.8.as_deref(), Some("retryable"));
}

#[test]
fn startup_interruption_with_future_imported_children_advances_terminal_timestamp() {
    let db = fixture_db();
    let work = WorkKey::new_for_epoch(
        PROJECT_ID,
        AutomaticRunKind::Backfill,
        LEGACY_BACKFILL_WORK_KEY,
        EPOCH_ID,
    )
    .expect("valid recovery work key");
    let spec = r#"{"backfillAlgorithmVersion":"3"}"#;
    let spec_digest = format!(
        "sha256:{}",
        digest_plan(&json!({ "backfillAlgorithmVersion": "3" }))
    );
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('future-interrupted-run', ?1, 'maintenance', '{}', ?2,
                     ?3, 'running', '{}',
                     '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z',
                     'backfill', ?4, ?5)",
            params![
                PROJECT_ID,
                spec,
                spec_digest,
                EPOCH_ID,
                LEGACY_BACKFILL_WORK_KEY
            ],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority, attempt_count,
                 created_at, started_at, version)
             VALUES ('future-interrupted-task', 'future-interrupted-run',
                     'maintenance-backfill', 'running', ?1, 0, 1,
                     '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:01.000Z', 0)",
            [spec],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES ('future-interrupted-attempt', 'future-interrupted-task',
                     1, 'running', '2099-01-01T00:00:02.000Z')",
            [],
        )?;
        Ok(())
    })
    .expect("seed future imported lifecycle");

    terminalize_interrupted_runs_for_epoch(
        &db,
        PROJECT_ID,
        &work,
        Some(EPOCH_ID),
        &["future-interrupted-run".to_string()],
    )
    .expect("startup interruption terminalizes imported lifecycle");
    let metadata: (String, String, String, String, String, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT r.status, t.status, a.status,
                        r.completed_at, t.completed_at, a.completed_at
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = 'future-interrupted-run'",
                [],
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
            )
            .map_err(Into::into)
        })
        .expect("read future imported lifecycle");
    assert_eq!(
        (&metadata.0, &metadata.1, &metadata.2),
        (
            &"failed".to_string(),
            &"failed".to_string(),
            &"failed".to_string()
        )
    );
    assert!(metadata.3.as_str() > "2099-01-01T00:00:02.000Z");
    assert_eq!(metadata.3, metadata.4);
    assert_eq!(metadata.4, metadata.5);
}
