//! C2-5B JOIN Phase 1 contracts.
//!
//! These tests pin the Rust-owned coordinate, durable discovery, completion
//! evidence, and same-Database phase dispatch boundary.

use grimodex_db::narrative_extraction::maintenance_runtime::{
    discover_durable_maintenance_work, plan_maintenance_trigger, run_system_work_cycle,
    AutomaticRunKind, MaintenanceCycleRequest, MaintenanceCycleStatus, MaintenanceTrigger,
    RecoveryMode, REBUILD_DERIVED_WORK_KEY,
};
use grimodex_db::narrative_extraction::{digest_plan, ensure_test_schema};
use grimodex_db::narrative_extraction::{
    run_dependency_verify_for_project, REBUILD_RUN_KIND_CONTRACT_VERSION,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-phase1";
const OLD_EPOCH_ID: &str = "epoch-c2-5b-phase1-old";
const EPOCH_ID: &str = "epoch-c2-5b-phase1";
const VERIFY_WORK_KEY: &str = "dependency-verify:epoch-c2-5b-phase1";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B Phase 1 project')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', datetime('now', '-1 day'))",
            params![OLD_EPOCH_ID, PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 1, 'restore', datetime('now'))",
            params![EPOCH_ID, PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed fixture");
    db
}

fn coordinate_bound_verify_request() -> MaintenanceCycleRequest {
    serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "workKey": VERIFY_WORK_KEY,
            "semanticEpochId": EPOCH_ID,
            "reasons": ["phase1-coordinate-check"]
        }],
        "wakeProjectIds": []
    }))
    .expect("Phase 1 dispatch must carry current graph/rule/producer coordinates")
}

fn seed_completed_backfill(db: &Database) {
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('phase1-backfill-completed', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"2"}', 'digest',
                     'completed', '{}', '2026-08-22T00:00:00.000Z',
                     '2026-08-22T00:00:01.000Z',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"2","semanticEpochId":"epoch-c2-5b-phase1","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2,
                     'legacy-dependency-backfill:v2')"#,
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed completed Backfill boundary");
}

fn rebuild_summary() -> serde_json::Value {
    json!({
        "consumersEvaluated": 0,
        "edgesEvaluated": 0,
        "consumersSkippedUnresolvableScope": 0,
        "edgesSkippedUnresolvableScope": 0
    })
}

fn rebuild_outcome(contract_version: Option<&str>) -> String {
    let summary = rebuild_summary();
    let mut outcome = json!({
        "semanticEpochId": EPOCH_ID,
        "summaryDigest": format!("sha256:{}", digest_plan(&summary)),
        "summary": summary,
    });
    if let Some(contract_version) = contract_version {
        outcome["rebuildContractVersion"] = json!(contract_version);
    }
    outcome.to_string()
}

fn seed_completed_rebuild(db: &Database, outcome_json: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('phase1-rebuild-completed', ?1, 'maintenance', '{}', '{}', 'digest',
                     'completed', '{}', '2026-08-22T00:01:00.000Z',
                     '2026-08-22T00:01:01.000Z', ?2, 'semantic-index-rebuild', ?3,
                     'dependency-rebuild-derived')",
            params![PROJECT_ID, outcome_json, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed completed Rebuild outcome");
}

#[test]
fn rebuild_contract_mismatch_is_repaired_after_verify_and_current_rebuild_does_not_loop() {
    for (label, outcome_json, expected_kind) in [
        (
            "old",
            rebuild_outcome(Some("0")),
            Some(AutomaticRunKind::RebuildDerived),
        ),
        (
            "missing",
            rebuild_outcome(None),
            Some(AutomaticRunKind::RebuildDerived),
        ),
        (
            "malformed",
            "{not-json".to_string(),
            Some(AutomaticRunKind::RebuildDerived),
        ),
        (
            "current",
            rebuild_outcome(Some(REBUILD_RUN_KIND_CONTRACT_VERSION)),
            None,
        ),
    ] {
        let db = fixture_db();
        seed_completed_backfill(&db);
        seed_completed_rebuild(&db, &outcome_json);
        run_dependency_verify_for_project(&db, PROJECT_ID)
            .expect("current Verify must seal evidence before Rebuild validation");

        let discovered = discover_durable_maintenance_work(&db, PROJECT_ID, "durable-wake")
            .expect("Rebuild contract discovery")
            .map(|work| work.run_kind);
        assert_eq!(
            discovered, expected_kind,
            "{label} Rebuild contract coordinate discovery"
        );
    }
}

#[test]
fn old_same_epoch_rebuild_runs_verify_rebuild_and_confirmation_verify() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    seed_completed_rebuild(&db, &rebuild_outcome(Some("0")));

    let request: MaintenanceCycleRequest = serde_json::from_value(json!({
        "work": [],
        "wakeProjectIds": [PROJECT_ID]
    }))
    .expect("durable wake request");
    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("old Rebuild contract must execute the repair sequence");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);

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
        .expect("read Rebuild contract repair sequence");
    assert_eq!(verify_count, 2, "Verify must bracket the repaired Rebuild");
    assert_eq!(
        rebuild_count, 2,
        "one new Rebuild must follow the old contract"
    );
    assert!(
        discover_durable_maintenance_work(&db, PROJECT_ID, "durable-wake")
            .expect("rediscover repaired maintenance")
            .is_none(),
        "current Rebuild plus confirmation Verify must not loop"
    );
}

#[test]
fn restore_and_epoch_rotation_are_verify_first_before_report_rebuild_confirmation() {
    for trigger in [
        MaintenanceTrigger::RestoreCompleted {
            project_id: PROJECT_ID.to_string(),
            semantic_epoch_id: EPOCH_ID.to_string(),
        },
        MaintenanceTrigger::EpochRotated {
            project_id: PROJECT_ID.to_string(),
            semantic_epoch_id: EPOCH_ID.to_string(),
        },
    ] {
        let planned = plan_maintenance_trigger(&trigger).expect("plan restore/epoch trigger");
        assert_eq!(
            planned.first().map(|work| work.run_kind),
            Some(AutomaticRunKind::Verify),
            "restore and epoch rotation must establish Verify before Rebuild"
        );
    }

    let restore = plan_maintenance_trigger(&MaintenanceTrigger::RestoreCompleted {
        project_id: PROJECT_ID.to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
    })
    .expect("plan restore trigger");
    let report_requested = plan_maintenance_trigger(&MaintenanceTrigger::BeforeCutover {
        project_id: PROJECT_ID.to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
    })
    .expect("plan report request");
    let sequence = restore
        .into_iter()
        .chain(report_requested)
        .map(|work| work.run_kind)
        .collect::<Vec<_>>();
    assert_eq!(
        sequence,
        vec![AutomaticRunKind::Verify, AutomaticRunKind::Verify],
        "planning must enqueue Verify only; Rust discovers conditional Rebuild from its report"
    );
}

#[test]
fn restore_epoch_without_backfill_history_runs_current_backfill_then_verify() {
    let db = fixture_db();
    let discovered = discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
        .expect("restore discovery")
        .expect("pre-C2 restore must not skip Backfill");
    assert_eq!(discovered.run_kind, AutomaticRunKind::Backfill);
    assert_eq!(discovered.semantic_epoch_id.as_deref(), Some(EPOCH_ID));

    let request: MaintenanceCycleRequest = serde_json::from_value(json!({
        "work": [],
        "wakeProjectIds": [PROJECT_ID]
    }))
    .expect("durable restore wake");
    run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("Backfill and Verify follow-up must run");
    let (backfill_count, verify_count): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    SUM(CASE WHEN run_kind = 'backfill' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read restore phase ledger");
    assert_eq!(backfill_count, 1);
    assert!(verify_count >= 1);
}

#[test]
fn restore_epoch_with_only_old_backfill_history_starts_current_verify() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('phase1-old-backfill-completed', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"2"}', 'digest',
                     'completed', '{}', '2026-08-20T00:00:00.000Z',
                     '2026-08-20T00:00:01.000Z',
                     '{"maintenancePhase":"backfill-complete","backfillAlgorithmVersion":"2","semanticEpochId":"epoch-c2-5b-phase1-old","summary":{"epoch_created":false,"contributions_created":0,"edges_created":0,"applications_without_run_id":0}}',
                     'backfill', ?2,
                     'legacy-dependency-backfill:v2')"#,
            params![PROJECT_ID, OLD_EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed old completed Backfill marker");

    let discovered = discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
        .expect("restore discovery")
        .expect("old Backfill marker must lead to Verify");
    assert_eq!(discovered.run_kind, AutomaticRunKind::Verify);
    assert_eq!(discovered.semantic_epoch_id.as_deref(), Some(EPOCH_ID));
}

#[test]
fn malformed_or_wrong_key_completed_backfill_does_not_cross_boundary() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('phase1-wrong-backfill-key', ?1, 'maintenance', '{}',
                     '{\"backfillAlgorithmVersion\":\"2\"}', 'digest',
                     'completed', '{}', '2026-08-20T00:00:00.000Z',
                     '2026-08-20T00:00:01.000Z', '{}', 'backfill', ?2,
                     'legacy-dependency-backfill:v1')",
            params![PROJECT_ID, EPOCH_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, outcome_summary_json,
                 run_kind, semantic_epoch_id, work_key)
             VALUES ('phase1-malformed-backfill-outcome', ?1, 'maintenance', '{}',
                     '{\"backfillAlgorithmVersion\":\"2\"}', 'digest',
                     'completed', '{}', '2026-08-21T00:00:00.000Z',
                     '2026-08-21T00:00:01.000Z', '{}', 'backfill', ?2,
                     'legacy-dependency-backfill:v2')",
            params![PROJECT_ID, EPOCH_ID],
        )?;
        Ok(())
    })
    .expect("seed malformed completed Backfill rows");

    let discovered = discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
        .expect("malformed Backfill discovery")
        .expect("malformed completion must rerun Backfill");
    assert_eq!(discovered.run_kind, AutomaticRunKind::Backfill);
    assert_eq!(discovered.semantic_epoch_id.as_deref(), Some(EPOCH_ID));
}

#[test]
fn actual_verify_dispatch_accepts_coordinate_bound_work_instead_of_a_deferred_ack() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    let request = coordinate_bound_verify_request();

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("coordinate-bound Verify dispatch");
    assert_ne!(
        result.status,
        MaintenanceCycleStatus::Deferred,
        "a coordinate mismatch must be evaluated by the dispatch contract, not hidden as a deferred ACK"
    );
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    let latest = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT run_kind FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'dependency-verify' LIMIT 1",
                [PROJECT_ID],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("read actual Verify Run");
    assert_eq!(latest, "dependency-verify");
}

#[test]
fn missing_derived_rows_force_verify_rerun_after_prior_skip_evidence() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES ('phase1-scene', ?1, 'scene', 'Phase 1',
                     '{\"type\":\"doc\",\"content\":[]}', 1, datetime('now'))",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key,
                 source_object_identity, read_set_json, created_at)
             VALUES ('phase1-edge', ?1, 'narrative-extraction-run',
                     'phase1-consumer', 'project:scene:phase1-scene', '[]', datetime('now'))",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed a graph whose derived projection is initially missing");

    let first = run_system_work_cycle(
        &db,
        &coordinate_bound_verify_request(),
        RecoveryMode::SameProcessLive,
    )
    .expect("missing derived rows must trigger Verify");
    assert_eq!(
        first.status,
        MaintenanceCycleStatus::Accepted,
        "Verify/Rebuild/confirmation must execute on the live authority"
    );

    let (verify_count, evidence_present, rebuild_count): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN outcome_summary_json LIKE '%reportDigest%' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read Verify completion evidence");
    assert!(
        verify_count >= 2,
        "confirmation Verify must follow the initial dirty Verify"
    );
    assert!(
        evidence_present >= 1,
        "only clean confirmation Verify may seal completion evidence"
    );
    assert_eq!(rebuild_count, 1, "one Rebuild must sit between Verify runs");

    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_dependency_edge_states WHERE project_id = ?1",
            [PROJECT_ID],
        )?;
        conn.execute(
            "DELETE FROM narrative_consumer_freshness WHERE project_id = ?1",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("remove derived projections after a clean completed Verify");

    let next = discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
        .expect("rediscover after derived projection deletion")
        .expect("a clean stored Verify must not hide missing live projections");
    assert_eq!(next.run_kind, AutomaticRunKind::Verify);

    let second = run_system_work_cycle(
        &db,
        &coordinate_bound_verify_request(),
        RecoveryMode::SameProcessLive,
    )
    .expect("missing derived projections must run Verify/Rebuild/confirmation again");
    assert_eq!(second.status, MaintenanceCycleStatus::Accepted);
    let (verify_after, rebuild_after): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                        SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read rerun phase ledger");
    assert!(verify_after >= verify_count + 2);
    assert_eq!(rebuild_after, rebuild_count + 1);
}

#[test]
fn restore_recovery_terminalizes_old_active_backfill_before_current_verify() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            r#"INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, run_kind, semantic_epoch_id, work_key)
             VALUES ('old-active-backfill', ?1, 'maintenance', '{}',
                     '{"backfillAlgorithmVersion":"2"}', 'digest',
                     'running', '{}', '2026-08-21T00:00:00.000Z', 'backfill', ?2, ?3)"#,
            params![PROJECT_ID, OLD_EPOCH_ID, "legacy-dependency-backfill:v2"],
        )?;
        Ok(())
    })
    .expect("seed old-epoch active Backfill");

    let request: MaintenanceCycleRequest = serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "backfill",
            "workKey": "legacy-dependency-backfill:v2",
            "semanticEpochId": OLD_EPOCH_ID,
            "reasons": ["restore-completed"]
        }],
        "wakeProjectIds": []
    }))
    .expect("old active Backfill request");
    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("stale active Backfill must recover into current Verify");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);

    let (old_status, current_verify_count): (String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    (SELECT status FROM narrative_extraction_runs
                      WHERE id = 'old-active-backfill'),
                    (SELECT COUNT(*) FROM narrative_extraction_runs
                      WHERE project_id = ?1 AND run_kind = 'dependency-verify'
                        AND semantic_epoch_id = ?2)",
                params![PROJECT_ID, EPOCH_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read stale recovery ledger");
    assert_eq!(old_status, "failed");
    assert!(current_verify_count >= 1);
}

#[test]
fn graph_defect_stops_after_verify_without_automatic_repair() {
    let db = fixture_db();
    seed_completed_backfill(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_dependency_edges
                (id, project_id, consumer_kind, consumer_key,
                 source_object_identity, read_set_json, created_at)
             VALUES ('missing-source-edge', ?1, 'narrative-extraction-run',
                     'defect-consumer', 'project:scene:does-not-exist', '[]',
                     '2026-08-23T00:00:00.000Z')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed graph defect with no resolvable source");

    let result = run_system_work_cycle(
        &db,
        &coordinate_bound_verify_request(),
        RecoveryMode::SameProcessLive,
    )
    .expect("graph defect must remain terminal evidence");
    assert_eq!(result.status, MaintenanceCycleStatus::Accepted);
    let (verify_count, rebuild_count, repair_count): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT
                    SUM(CASE WHEN run_kind = 'dependency-verify' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'semantic-index-rebuild' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN run_kind = 'repair' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs WHERE project_id = ?1",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("read graph defect phase ledger");
    assert!(verify_count >= 2, "confirmation Verify must execute");
    assert_eq!(rebuild_count, 1, "derived projections are rebuilt once");
    assert_eq!(repair_count, 0, "Repair must never be auto-dispatched");
    assert!(
        discover_durable_maintenance_work(&db, PROJECT_ID, "restore-completed")
            .expect("rediscover graph defect")
            .is_none()
    );
}

#[test]
fn repair_is_not_an_automatic_dispatch_kind() {
    let repair: Result<MaintenanceCycleRequest, _> = serde_json::from_value(json!({
        "work": [{
            "projectId": PROJECT_ID,
            "runKind": "repair",
            "workKey": "repair",
            "semanticEpochId": null,
            "reasons": ["phase1-negative"]
        }],
        "wakeProjectIds": []
    }));
    assert!(
        repair.is_err(),
        "Repair must remain unrepresentable in automatic work"
    );
    assert_eq!(REBUILD_DERIVED_WORK_KEY, "dependency-rebuild-derived");
}
