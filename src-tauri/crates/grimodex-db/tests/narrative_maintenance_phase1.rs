//! C2-5B JOIN Phase 1 red-first contracts.
//!
//! These tests describe the post-C2-3 dispatch boundary without activating it.
//! They intentionally fail against the A/B-only join until the C-owned
//! coordinate, discovery, and completion-evidence seams are integrated.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_runtime::{
    plan_maintenance_trigger, run_system_work_cycle, AutomaticRunKind, MaintenanceCycleRequest,
    MaintenanceCycleStatus, MaintenanceTrigger, RecoveryMode, REBUILD_DERIVED_WORK_KEY,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-phase1";
const EPOCH_ID: &str = "epoch-c2-5b-phase1";
const GRAPH_DIGEST: &str = "sha256:graph-phase1";
const RULE_DIGEST: &str = "sha256:rules-phase1";
const PRODUCER_DIGEST: &str = "sha256:producer-phase1";
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
             VALUES (?1, ?2, 0, 'initial', datetime('now'))",
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
            "reasons": ["phase1-coordinate-check"],
            "graphContractDigest": GRAPH_DIGEST,
            "ruleRegistryDigest": RULE_DIGEST,
            "producerGenerationSetDigest": PRODUCER_DIGEST
        }],
        "wakeProjectIds": []
    }))
    .expect("Phase 1 dispatch must carry current graph/rule/producer coordinates")
}

fn completed_verify_outcome() -> String {
    json!({
        "semanticEpochId": EPOCH_ID,
        "skipEvidence": {
            "projectId": PROJECT_ID,
            "runKind": "dependency-verify",
            "semanticEpochId": EPOCH_ID,
            "graphContractDigest": GRAPH_DIGEST,
            "ruleRegistryDigest": RULE_DIGEST,
            "producerGenerationSetDigest": PRODUCER_DIGEST,
            "runKindContractVersion": "1",
            "reportDigest": "sha256:prior-verify"
        }
    })
    .to_string()
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
        vec![
            AutomaticRunKind::Verify,
            AutomaticRunKind::RebuildDerived,
            AutomaticRunKind::Verify,
        ],
        "the report request must rebuild only after the first Verify and confirm with Verify"
    );
}

#[test]
fn actual_verify_dispatch_accepts_coordinate_bound_work_instead_of_a_deferred_ack() {
    let db = fixture_db();
    let request = coordinate_bound_verify_request();

    let result = run_system_work_cycle(&db, &request, RecoveryMode::SameProcessLive)
        .expect("coordinate-bound Verify dispatch");
    assert_ne!(
        result.status,
        MaintenanceCycleStatus::Deferred,
        "a coordinate mismatch must be evaluated by the dispatch contract, not hidden as a deferred ACK"
    );
}

#[test]
fn missing_derived_rows_force_verify_rerun_after_prior_skip_evidence() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, completed_at, run_kind,
                 semantic_epoch_id, work_key, outcome_summary_json)
             VALUES ('prior-verify', ?1, 'maintenance', '{}', '{}', 'digest',
                     'completed', '{}', datetime('now'), datetime('now'),
                     'dependency-verify', ?2, ?3, ?4)",
            params![PROJECT_ID, EPOCH_ID, VERIFY_WORK_KEY, completed_verify_outcome()],
        )?;
        Ok(())
    })
    .expect("seed prior Verify skip evidence");

    let result = run_system_work_cycle(
        &db,
        &coordinate_bound_verify_request(),
        RecoveryMode::SameProcessLive,
    )
    .expect("missing derived rows must trigger Verify");
    assert_eq!(
        result.status,
        MaintenanceCycleStatus::Accepted,
        "a prior Verify skip cannot ACK while its derived rows are missing or stale"
    );

    let (run_count, evidence_present): (i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*),
                        SUM(CASE WHEN outcome_summary_json LIKE '%skipEvidence%' THEN 1 ELSE 0 END)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND run_kind = 'dependency-verify'",
                [PROJECT_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read Verify completion evidence");
    assert!(run_count >= 2, "Verify must create a fresh Run after stale derived state");
    assert!(
        evidence_present >= 2,
        "Verify completion evidence must be sealed with the terminal Run"
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
    assert!(repair.is_err(), "Repair must remain unrepresentable in automatic work");
    assert_eq!(REBUILD_DERIVED_WORK_KEY, "dependency-rebuild-derived");
}
