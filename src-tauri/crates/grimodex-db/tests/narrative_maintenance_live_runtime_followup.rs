//! Follow-up acceptance contracts for the C2-5B live maintenance seam.
//!
//! These tests are intentionally separate from the first red-first contract
//! commit: they pin the review fixes before the runtime implementation moves
//! again.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    run_system_work_cycle, AutomaticRunKind, MaintenanceCycleRequest, MaintenanceCycleResult,
    MaintenanceCycleStatus, RecoveryMode, LEGACY_BACKFILL_WORK_KEY,
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
                     '{"backfillAlgorithmVersion":"2"}', 'digest',
                     'completed', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"2","semanticEpochId":"epoch-c2-5b-followup","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2,
                     'legacy-dependency-backfill:v2')"#,
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed completed Backfill boundary");
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
                     '{"backfillAlgorithmVersion":"2"}', 'digest',
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
    for completed_at in [None, Some("not-a-supported-instant")] {
        let db = Arc::new(fixture_db());
        db.with_conn(|conn| {
            conn.execute(
                r#"INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, completed_at, outcome_summary_json,
                     run_kind, semantic_epoch_id, work_key)
                 VALUES ('malformed-backfill-timestamp', ?1, 'maintenance', '{}',
                         '{"backfillAlgorithmVersion":"2"}', 'digest',
                         'completed', '{}', '2026-08-22T00:00:00.000Z', ?3,
                         '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"2","semanticEpochId":"epoch-c2-5b-followup","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                         'backfill', ?2, 'legacy-dependency-backfill:v2')"#,
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
        let result = result_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("timestamp-invalid Backfill must not rediscover forever")
            .expect("timestamp-invalid Backfill must be rerunnable");
        assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
        assert!(!result.has_more);

        let (run_count, valid_completed_count): (i64, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*),
                            SUM(CASE WHEN status = 'completed'
                                          AND outcome_summary_json LIKE '%backfill-complete%'
                                          AND completed_at IS NOT NULL
                                          AND (?3 IS NULL OR completed_at != ?3)
                                     THEN 1 ELSE 0 END)
                       FROM narrative_extraction_runs
                      WHERE project_id = ?1 AND run_kind = 'backfill'
                        AND work_key = ?2",
                    params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY, completed_at],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .expect("read timestamp-invalid Backfill ledger");
        assert_eq!(run_count, 2);
        assert_eq!(valid_completed_count, 1);
    }
}

#[test]
fn recovery_mode_must_be_startup_again_after_a_workspace_generation_change() {
    let db = fixture_db();
    let request = backfill_request();

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('generation-one-interrupted', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', datetime('now'), 'backfill', ?2, ?3)",
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed first generation interruption");
    run_system_work_cycle(&db, &request, RecoveryMode::StartupRecovery)
        .expect("recover first generation");

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('generation-two-interrupted', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', datetime('now'), 'backfill', ?2, ?3)",
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
