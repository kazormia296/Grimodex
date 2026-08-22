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
