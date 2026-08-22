//! Regression contracts for the C2-5B-A acceptance re-review.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    run_system_work_cycle, MaintenanceCycleRequest, MaintenanceCycleResult, RecoveryMode,
    LEGACY_BACKFILL_WORK_KEY,
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
                .query_map(params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY], |row| row.get(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read retry ledger");
    assert_eq!(statuses, vec!["failed", "completed"]);
}

#[test]
fn durable_contract_failure_is_not_redispatched() {
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

    let error = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::StartupRecovery)
        .expect_err("contract failure must require manual intervention");
    assert!(error.to_string().contains("NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"));
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
