//! Regression contracts for the C2-5B-A acceptance re-review.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    discover_durable_maintenance_work, run_system_work_cycle, AutomaticRunKind,
    MaintenanceCycleRequest, MaintenanceCycleResult, RecoveryMode, LEGACY_BACKFILL_WORK_KEY,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "project-c2-5b-reacceptance";
const EPOCH_ID: &str = "epoch-c2-5b-reacceptance";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B reacceptance project')",
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
            "reasons": ["reacceptance-test"]
        }],
        "wakeProjectIds": []
    }))
    .expect("valid cycle request")
}

fn seed_completed_backfill_marker(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('completed-backfill-marker', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"3"}', 'digest', 'completed', '{}',
                     '2026-08-23T09:00:00.000Z', '2026-08-23T09:00:01.000Z',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"3","semanticEpochId":"epoch-c2-5b-reacceptance","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2, ?3)"#,
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed completed Backfill marker");
}

fn seed_failed_backfill_without_terminal(db: &Database, run_id: &str, reason: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, started_at, completed_at,
                 run_kind, semantic_epoch_id, work_key, terminal_reason_code)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'digest',
                     'failed', '{}', '2026-08-23T10:00:00.000Z', NULL, NULL,
                     'backfill', ?3, ?4, ?5)",
            params![
                run_id,
                PROJECT_ID,
                EPOCH_ID,
                LEGACY_BACKFILL_WORK_KEY,
                reason
            ],
        )?;
        Ok(())
    })
    .expect("seed failed Backfill without completed_at");
}

#[test]
fn ordinary_work_and_durable_wake_are_rejected_as_one_ack_scope() {
    let db = fixture_db();
    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "backfill",
            "workKey": LEGACY_BACKFILL_WORK_KEY,
            "semanticEpochId": null,
            "reasons": ["ordinary-work"]
        }],
        "wakeProjectIds": [PROJECT_ID]
    }))
    .expect("validly shaped mixed request");

    let error = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect_err("ordinary work and wake must have separate ACK scopes");
    assert!(error.to_string().contains("WAKE_MIXED"));
}

#[test]
fn durable_wake_batch_is_bounded_to_the_native_cycle_limit() {
    let db = fixture_db();
    let request = MaintenanceCycleRequest {
        work: Vec::new(),
        wake_project_ids: (0..33)
            .map(|index| format!("wake-project-{index}"))
            .collect(),
        workspace_binding: None,
    };

    let error = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect_err("native wake scope must be bounded before durable lookup");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_BATCH_TOO_LARGE"));
}

#[test]
fn durable_transient_failure_is_retried_and_succeeds_after_lock_release() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key,
                 terminal_reason_code)
             VALUES ('transient-failed-run', ?1, 'maintenance', '{}', '{}', 'digest',
                     'failed', '{}', datetime('now'), 'backfill', ?2, ?3,
                     'NEX_MAINTENANCE_SQLITE_LOCKED')",
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed durable transient failure");

    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::StartupRecovery)
        .expect("released lock allows bounded retry");
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    let statuses: Vec<String> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT status FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND work_key = ?2 ORDER BY rowid",
            )?;
            let rows = statement
                .query_map(params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY], |row| {
                    row.get(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read retry ledger");
    assert_eq!(statuses, vec!["failed", "completed"]);
}

#[test]
fn retryable_failed_null_terminal_is_accepted_but_nonretryable_is_rejected() {
    let retryable_db = fixture_db();
    seed_completed_backfill_marker(&retryable_db);
    seed_failed_backfill_without_terminal(
        &retryable_db,
        "retryable-failed-without-terminal",
        "NEX_MAINTENANCE_SQLITE_LOCKED",
    );

    let discovered =
        discover_durable_maintenance_work(&retryable_db, PROJECT_ID, "reacceptance-test")
            .expect("retryable failed Backfill must remain selectable")
            .expect("retryable failed Backfill must request retry");
    assert_eq!(discovered.run_kind, AutomaticRunKind::Backfill);

    for (index, reason) in [
        "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
        "NEX_FAKE_SQLITE_LOCKED",
        "NEX_MAINTENANCE_SQLITE_LOCKED_EXTRA",
        "NEX_VERIFY_STALE_EPOCH",
        "NEX_UNKNOWN_FAILURE",
    ]
    .into_iter()
    .enumerate()
    {
        let nonretryable_db = fixture_db();
        seed_completed_backfill_marker(&nonretryable_db);
        seed_failed_backfill_without_terminal(
            &nonretryable_db,
            &format!("nonretryable-failed-without-terminal-{index}"),
            reason,
        );

        let error =
            discover_durable_maintenance_work(&nonretryable_db, PROJECT_ID, "reacceptance-test")
                .expect_err("nonretryable failed Backfill without completed_at must fail closed");
        assert!(error
            .to_string()
            .contains("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID"));
    }
}

#[test]
fn durable_contract_failure_is_a_handled_terminal_halt_not_redispatched() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key,
                 terminal_reason_code)
             VALUES ('contract-failed-run', ?1, 'maintenance', '{}', '{}', 'digest',
                     'failed', '{}', datetime('now'), 'backfill', ?2, ?3,
                     'NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION')",
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed durable contract failure");

    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::StartupRecovery)
        .expect("contract failure is a handled terminal halt");
    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    let run_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get(0),
            )?)
        })
        .expect("read contract ledger");
    assert_eq!(run_count, 1);
}
