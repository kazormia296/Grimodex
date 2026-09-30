//! Follow-up acceptance contracts for the C2-5B live maintenance seam.
//!
//! These tests are intentionally separate from the first red-first contract
//! commit: they pin the review fixes before the runtime implementation moves
//! again.

use grimodex_db::narrative_extraction::maintenance_runtime::{
    run_system_work_cycle, AutomaticRunKind, MaintenanceCycleRequest, MaintenanceCycleResult,
    MaintenanceCycleStatus, RecoveryMode, LEGACY_BACKFILL_WORK_KEY,
};
use grimodex_db::narrative_extraction::{
    bootstrap_legacy_dependency_backfill_for_project, ensure_test_schema,
    run_dependency_verify_for_project,
};
use grimodex_db::Database;
use rusqlite::params;
use std::sync::{mpsc, Arc};
use std::time::Duration;

const PROJECT_ID: &str = "project-c2-5b-followup";
const EPOCH_ID: &str = "epoch-c2-5b-followup";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B follow-up project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', datetime('now'))",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed fixture");
    db
}

fn backfill_request() -> MaintenanceCycleRequest {
    serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "backfill",
            "workKey": LEGACY_BACKFILL_WORK_KEY,
            "semanticEpochId": null,
            "reasons": ["workspace-opened"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid cycle request")
}

fn seed_completed_backfill(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('followup-backfill-completed', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest',
                     'completed', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"3","semanticEpochId":"epoch-c2-5b-followup","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2,
                     'legacy-dependency-backfill:v3')"#,
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed completed Backfill boundary");
}

fn seed_future_malformed_backfill(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at, completed_at,
                 outcome_summary_json, run_kind, semantic_epoch_id, work_key)
             VALUES ('future-malformed-completed-at', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest', 'completed', '{}',
                     '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
                     'not-an-instant',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"3","semanticEpochId":"epoch-c2-5b-followup","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2, 'legacy-dependency-backfill:v3')"#,
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed future Backfill with malformed completed_at");
}

#[test]
fn verify_kind_dispatches_on_the_live_authority_instead_of_deferred_ack() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "workKey": "dependency-verify:epoch-c2-5b-followup",
            "semanticEpochId": EPOCH_ID,
            "reasons": ["verify-requested"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid Verify request");

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("live Verify maintenance cycle");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    let run_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'dependency-verify'",
                [PROJECT_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read live Verify ledger");
    assert_eq!(run_count, 1, "Verify must reach its Rust-owned adapter");
}

#[test]
fn malformed_active_verify_work_key_fails_before_coalescing_or_dispatch() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('malformed-active-verify', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', '2026-08-23T00:00:00.000Z',
                     '2026-08-23T00:00:01.000Z', 'dependency-verify', ?2,
                     'dependency-verify:not-the-bound-epoch')",
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed malformed active Verify");

    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "workKey": format!("dependency-verify:{EPOCH_ID}"),
            "semanticEpochId": EPOCH_ID,
            "reasons": ["verify-requested"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid Verify request");

    let error = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect_err("malformed active Verify must fail closed before coalescing");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_ACTIVE_LEDGER_INVALID"));
    let run_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'dependency-verify'",
                [PROJECT_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read malformed Verify ledger");
    assert_eq!(
        run_count, 1,
        "failure must not dispatch a replacement Verify"
    );
}

#[test]
fn empty_wake_reports_durable_active_work_as_coalesced_continuation() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('pending-wake-run', ?1, 'maintenance', '{}', '{}', 'digest',
                     'pending', '{}', datetime('now'), 'backfill', ?2, ?3)",
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed pending durable work");

    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [],
        "wakeProjectIds": [PROJECT_ID]
    }))
    .expect("valid durable wake");
    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("durable wake cycle");

    assert_eq!(result, MaintenanceCycleResult::coalesced(true));
}

#[test]
fn completed_verify_skip_followed_by_live_rebuild_is_accepted_not_coalesced() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    run_dependency_verify_for_project(&db, PROJECT_ID)
        .expect("clean Verify must seal reusable skip evidence");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('followup-rebuild-running', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', '2026-08-23T00:00:00.000Z',
                     '2026-08-23T00:00:01.000Z', 'semantic-index-rebuild', ?2,
                     'dependency-rebuild-derived')",
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed live Rebuild owned by another scheduler invocation");

    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "workKey": format!("dependency-verify:{EPOCH_ID}"),
            "semanticEpochId": EPOCH_ID,
            "reasons": ["verify-requested"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid Verify request");

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("Verify skip plus live Rebuild coalescing must finish");
    assert_eq!(
        result,
        MaintenanceCycleResult::accepted(true),
        "the handled Verify skip means this mixed cycle is accepted, not wholly coalesced"
    );
    let (verify_count, rebuild_count, running_rebuilds): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'semantic-index-rebuild' AND status = 'running' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read mixed Verify/Rebuild ledger");
    assert_eq!(verify_count, 1, "the completed Verify must be reused");
    assert_eq!(
        rebuild_count, 1,
        "the existing Rebuild must not be duplicated"
    );
    assert_eq!(
        running_rebuilds, 1,
        "the live Rebuild remains owned by its caller"
    );
}

#[test]
fn completed_verify_skip_followed_by_live_same_verify_is_coalesced() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    run_dependency_verify_for_project(&db, PROJECT_ID)
        .expect("clean Verify must seal reusable skip evidence");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('followup-verify-running', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z', 'dependency-verify', ?2, ?3)",
            params![
                PROJECT_ID,
                EPOCH_ID,
                format!("dependency-verify:{EPOCH_ID}")
            ],
        )?;
        Ok(())
    })
    .expect("seed live same-key Verify confirmation");

    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "workKey": format!("dependency-verify:{EPOCH_ID}"),
            "semanticEpochId": EPOCH_ID,
            "reasons": ["verify-requested"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid Verify request");

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("same-key Verify coalescing must finish");
    assert_eq!(
        result,
        MaintenanceCycleResult::coalesced(true),
        "same-key Verify confirmation is wholly live-owned and must remain coalesced"
    );
    let (verify_count, running_verify_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'dependency-verify'",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read same-key Verify ledger");
    assert_eq!(verify_count, 2, "the live confirmation must be durable");
    assert_eq!(
        running_verify_count, 1,
        "the existing Verify remains owned live"
    );
}

#[test]
fn a_completed_backfill_does_not_report_a_durable_remaining_page() {
    let db = fixture_db();
    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::SameProcessLive)
        .expect("backfill cycle");
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
}

#[test]
fn malformed_completed_backfill_is_reexecuted_without_a_rediscovery_loop() {
    let db = Arc::new(fixture_db());
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('malformed-backfill-completed', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest',
                     'completed', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z', '{}', 'backfill', ?2, ?3)"#,
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed malformed completed Backfill");

    let db_for_cycle = Arc::clone(&db);
    let (result_tx, result_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = run_system_work_cycle(
            &db_for_cycle,
            &backfill_request(),
            RecoveryMode::SameProcessLive,
        );
        let _ = result_tx.send(result);
    });
    let result = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("malformed completed Backfill must terminate its full cycle");
    let result = result.expect("malformed completed Backfill must be rerunnable");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    assert!(!result.has_more);

    let (run_count, valid_completed_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN status = 'completed'
                                      AND outcome_summary_json LIKE '%backfill-complete%'
                                 THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill'
                    AND work_key = ?2",
                params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read rerun Backfill ledger");
    assert_eq!(
        run_count, 2,
        "one fresh Backfill execution must replace the malformed marker"
    );
    assert_eq!(
        valid_completed_count, 1,
        "the rerun must leave one valid completion marker"
    );
}

#[test]
fn malformed_completed_backfill_timestamp_is_not_reused_and_cycle_is_bounded() {
    // A completed marker with NULL completed_at is not reusable evidence, so
    // one bounded rerun replaces it. A marker carrying an unparseable
    // instant is corrupted ordering evidence: the lifecycle allocator fails
    // the cycle closed (NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID) instead of
    // silently ordering new work past the broken row — either way the cycle
    // terminates instead of rediscovering forever.
    for completed_at in [None, Some("not-a-supported-instant")] {
        let db = Arc::new(fixture_db());
        db.with_conn(|conn| {
            conn.execute(
                r#"INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, completed_at, outcome_summary_json,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES ('malformed-backfill-timestamp', ?1, 'maintenance', '{}',
                         '{"backfillAlgorithmVersion":"3"}', 'digest',
                         'completed', '{}', '2026-08-22T00:00:00.000Z', ?3,
                         '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"3","semanticEpochId":"epoch-c2-5b-followup","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                         'backfill', ?2, 'legacy-dependency-backfill:v3')"#,
                params![PROJECT_ID, EPOCH_ID, completed_at],
            )?;
            Ok(())
        })
        .expect("seed timestamp-invalid Backfill marker");

        let db_for_cycle = Arc::clone(&db);
        let (result_tx, result_rx) = mpsc::channel();
        std::thread::spawn(move || {
            let result = run_system_work_cycle(
                &db_for_cycle,
                &backfill_request(),
                RecoveryMode::SameProcessLive,
            );
            let _ = result_tx.send(result);
        });
        let outcome = result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("timestamp-invalid Backfill must not rediscover forever");

        if completed_at.is_none() {
            let result = outcome.expect("marker without completed_at must be rerunnable");
            assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
            assert!(!result.has_more);
            let (run_count, valid_completed_count): (i64, i64) = db
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT COUNT(*),
                                SUM(CASE WHEN status = 'completed'
                                              AND outcome_summary_json LIKE '%backfill-complete%'
                                              AND completed_at IS NOT NULL
                                         THEN 1 ELSE 0 END)
                           FROM narrative_extraction_runs
                          WHERE project_id = ?1 AND run_kind = 'backfill'
                            AND work_key = ?2",
                        params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )?)
                })
                .expect("read timestamp-invalid Backfill ledger");
            assert_eq!(run_count, 2);
            assert_eq!(valid_completed_count, 1);
        } else {
            let error =
                outcome.expect_err("an unparseable marker instant must fail the allocator closed");
            assert!(error
                .to_string()
                .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));
            let run_count: i64 = db
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT COUNT(*) FROM narrative_extraction_runs
                          WHERE project_id = ?1 AND run_kind = 'backfill'
                            AND work_key = ?2",
                        params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY],
                        |row| row.get(0),
                    )?)
                })
                .expect("read timestamp-invalid Backfill ledger");
            assert_eq!(
                run_count, 1,
                "no new Run may be minted past corrupted ordering evidence"
            );
        }
    }
}

#[test]
fn malformed_completed_at_does_not_hide_a_future_backfill_lifecycle() {
    // The seeded Run carries valid FUTURE created/started instants and a
    // corrupted completed_at. The allocator cannot prove which of the row's
    // instants are trustworthy, so instead of guessing (and possibly hiding
    // the future authority behind the broken field) it fails closed on the
    // corrupted instant everywhere new lifecycle work would be minted.
    let db = Arc::new(fixture_db());
    seed_future_malformed_backfill(&db);

    let error = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::SameProcessLive)
        .expect_err("corrupted durable ordering evidence must fail the cycle closed");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));
    let run_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill'",
                [PROJECT_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read Backfill ledger");
    assert_eq!(
        run_count, 1,
        "no fresh Backfill may be minted past corrupted ordering evidence"
    );

    let discovery_db = fixture_db();
    seed_future_malformed_backfill(&discovery_db);
    let bootstrap_error =
        bootstrap_legacy_dependency_backfill_for_project(&discovery_db, PROJECT_ID)
            .expect_err("bootstrap past corrupted ordering evidence must fail closed");
    assert!(bootstrap_error
        .to_string()
        .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));
}

#[test]
fn recovery_mode_must_be_startup_again_after_a_workspace_generation_change() {
    let db = fixture_db();
    let request = backfill_request();

    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('generation-one-interrupted', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest',
                     'running', '{}', datetime('now'), 'backfill', ?2, ?3)"#,
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed first generation interruption");
    run_system_work_cycle(&db, &request, RecoveryMode::StartupRecovery)
        .expect("recover first generation");

    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('generation-two-interrupted', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest',
                     'running', '{}', datetime('now'), 'backfill', ?2, ?3)"#,
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed second generation interruption");
    run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("same-process mode must remain safe");

    let status: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'generation-two-interrupted'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("read second generation status");
    assert_eq!(status, "running");
}

#[test]
fn automatic_kind_set_remains_closed() {
    assert_eq!(AutomaticRunKind::all().len(), 3);
}
