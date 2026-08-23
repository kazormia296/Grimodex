//! C2-5B-A live Workspace-authority maintenance cycle contract tests.
//!
//! These tests call the cycle against the exact `Database` supplied by the
//! caller.  A future Electron/N-API adapter must not open a detached writer
//! for this path.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    run_system_work_cycle, AutomaticRunKind, MaintenanceCycleRequest, MaintenanceCycleResult,
    MaintenanceCycleStatus, RecoveryMode, LEGACY_BACKFILL_WORK_KEY,
};
use grimodex_db::Database;
use rusqlite::params;

const PROJECT_ID: &str = "project-c2-5b-live";
const EPOCH_ID: &str = "epoch-c2-5b-live";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B live project')",
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

#[test]
fn live_cycle_executes_backfill_on_the_supplied_database() {
    let db = fixture_db();

    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::SameProcessLive)
        .expect("live maintenance cycle");

    assert_eq!(result, MaintenanceCycleResult::accepted(false));
    let run_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill' AND work_key = ?2",
                params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY],
                |row| row.get(0),
            )?)
        })
        .expect("read run ledger");
    assert_eq!(run_count, 1, "the live authority must own the system Run");
}

#[test]
fn startup_cycle_recovers_an_interrupted_run_before_reusing_work_identity() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('interrupted-run', ?1, 'maintenance', '{}', '{}', 'digest',
                     'running', '{}', datetime('now'), 'backfill', ?2, ?3)",
            params![PROJECT_ID, EPOCH_ID, LEGACY_BACKFILL_WORK_KEY],
        )?;
        Ok(())
    })
    .expect("seed interrupted run");

    let result = run_system_work_cycle(&db, &backfill_request(), RecoveryMode::StartupRecovery)
        .expect("startup recovery cycle");
    assert_eq!(result, MaintenanceCycleResult::accepted(false));

    let statuses: Vec<(String, String, Option<String>)> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, status, terminal_reason_code
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'backfill' AND work_key = ?2
                  ORDER BY rowid",
            )?;
            let rows = statement
                .query_map(params![PROJECT_ID, LEGACY_BACKFILL_WORK_KEY], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .expect("read recovered ledger");
    assert_eq!(statuses.len(), 2);
    assert_eq!(statuses[0].0, "interrupted-run");
    assert_eq!(statuses[0].1, "failed");
    assert_eq!(
        statuses[0].2.as_deref(),
        Some("NEX_MAINTENANCE_INTERRUPTED")
    );
    assert_eq!(statuses[1].1, "completed");
}

#[test]
fn verify_and_rebuild_dispatch_on_the_live_authority_with_durable_phase_evidence() {
    let db = fixture_db();
    let request: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [
            {
                "projectId": PROJECT_ID,
                "runKind": "dependency-verify",
                "workKey": "dependency-verify:epoch-c2-5b-live",
                "semanticEpochId": EPOCH_ID,
                "reasons": ["verify-requested"]
            },
            {
                "projectId": PROJECT_ID,
                "runKind": "semantic-index-rebuild",
                "workKey": "dependency-rebuild-derived",
                "semanticEpochId": EPOCH_ID,
                "reasons": ["derived-state-invalid"]
            }
        ],
        "wakeProjectIds": []
    }))
    .expect("valid live request");

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("live Verify/Rebuild cycle");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    let (verify_count, rebuild_count, completed_count): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read live phase ledger");
    assert!(
        verify_count >= 1,
        "Verify must create durable phase evidence"
    );
    assert!(
        rebuild_count >= 1,
        "Rebuild must create durable phase evidence"
    );
    assert!(completed_count >= 2, "live phases must finalize their Runs");
}

#[test]
fn cycle_request_rejects_repair_and_path_separators() {
    let repair: Result<MaintenanceCycleRequest, _> = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-repair",
            "workKey": "repair",
            "semanticEpochId": null,
            "reasons": ["bad"]
        }],
        "wakeProjectIds": []
    }));
    assert!(repair.is_err());

    let path: MaintenanceCycleRequest = serde_json::from_value(serde_json::json!({
        "work": [{
            "projectId": "project/other",
            "runKind": "backfill",
            "workKey": LEGACY_BACKFILL_WORK_KEY,
            "semanticEpochId": null,
            "reasons": ["bad"]
        }],
        "wakeProjectIds": []
    }))
    .expect("serde only checks the closed enum");
    assert!(run_system_work_cycle(&fixture_db(), &path, RecoveryMode::SameProcessLive).is_err());
}

#[test]
fn automatic_kind_set_matches_dispatch_surface() {
    assert_eq!(AutomaticRunKind::all().len(), 3);
}
