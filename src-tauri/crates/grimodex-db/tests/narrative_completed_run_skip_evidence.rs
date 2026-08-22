//! C2-5B-B contract-aware completed-Run skip evidence.
//!
//! These tests exercise only the durable evidence reader/writer and its
//! fail-closed decision. They do not start the Electron scheduler or any
//! Verify/Rebuild production trigger.

use grimodex_db::narrative_extraction::ensure_test_schema;
use grimodex_db::narrative_extraction::maintenance_skip_evidence::{
    evaluate_completed_run_skip, persist_completed_run_skip_evidence,
    read_completed_run_skip_evidence, CompletedRunSkipDecision, CompletedRunSkipEvidence,
    CompletedRunSkipExpectation, CompletedRunSkipReason,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::json;

const PROJECT_ID: &str = "project-c2-5b-b";
const EPOCH_ID: &str = "epoch-c2-5b-b";
const RUN_ID: &str = "run-c2-5b-b";
const GRAPH_DIGEST: &str = "sha256:graph-contract-1";
const RULE_DIGEST: &str = "sha256:rule-registry-1";
const PRODUCER_DIGEST: &str = "sha256:producer-generations-1";
const RUN_CONTRACT_VERSION: &str = "5";
const REPORT_DIGEST: &str =
    "sha256:c5dae8fdbd5af47a09e41389299de8712f65576f800bf3a8aa9f26040a2b9e9f";
const REBUILD_RUN_ID: &str = "run-c2-5b-b-rebuild";
const REBUILD_REPORT_DIGEST: &str =
    "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

fn fixture_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-5B-B project')",
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

fn report() -> serde_json::Value {
    json!({"totalEdges": 0, "edgeIdsWithMissingSource": []})
}

fn evidence() -> CompletedRunSkipEvidence {
    CompletedRunSkipEvidence {
        project_id: PROJECT_ID.to_string(),
        run_kind: "dependency-verify".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: RUN_CONTRACT_VERSION.to_string(),
        report_digest: REPORT_DIGEST.to_string(),
    }
}

fn expectation() -> CompletedRunSkipExpectation {
    CompletedRunSkipExpectation {
        project_id: PROJECT_ID.to_string(),
        run_kind: "dependency-verify".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: RUN_CONTRACT_VERSION.to_string(),
        report_digest: Some(REPORT_DIGEST.to_string()),
    }
}

fn rebuild_evidence() -> CompletedRunSkipEvidence {
    CompletedRunSkipEvidence {
        project_id: PROJECT_ID.to_string(),
        run_kind: "semantic-index-rebuild".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: "1".to_string(),
        report_digest: REBUILD_REPORT_DIGEST.to_string(),
    }
}

fn rebuild_expectation() -> CompletedRunSkipExpectation {
    CompletedRunSkipExpectation {
        project_id: PROJECT_ID.to_string(),
        run_kind: "semantic-index-rebuild".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: "1".to_string(),
        report_digest: Some(REBUILD_REPORT_DIGEST.to_string()),
    }
}

fn insert_completed_verify_run(db: &Database, status: &str, outcome: Option<serde_json::Value>) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, completed_at,
                 version, run_kind, semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'spec', ?3, '{}', ?4,
                     datetime('now'), CASE WHEN ?3 = 'completed' THEN datetime('now') ELSE NULL END,
                     0, 'dependency-verify', ?5, ?6)",
            params![
                RUN_ID,
                PROJECT_ID,
                status,
                outcome.map(|value| value.to_string()),
                EPOCH_ID,
                format!("dependency-verify:{EPOCH_ID}"),
            ],
        )?;
        Ok(())
    })
    .expect("insert run");
}

fn successful_outcome() -> serde_json::Value {
    json!({
        "verifyContractVersion": RUN_CONTRACT_VERSION,
        "semanticEpochId": EPOCH_ID,
        "reportDigest": REPORT_DIGEST,
        "report": report(),
    })
}

#[test]
fn exact_contract_match_returns_skip_with_the_durable_report_digest() {
    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(successful_outcome()));
    persist_completed_run_skip_evidence(&db, RUN_ID, &evidence()).expect("persist skip evidence");

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
        .expect("evaluate skip");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Skip {
            run_id: RUN_ID.to_string(),
            report_digest: REPORT_DIGEST.to_string(),
        }
    );
    let stored = db
        .with_conn(|conn| read_completed_run_skip_evidence(conn, PROJECT_ID, "dependency-verify"))
        .expect("read persisted evidence");
    assert_eq!(stored, Some(evidence()));

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET outcome_summary_json = ?1 WHERE id = ?2",
            params![
                json!({
                    "verifyContractVersion": RUN_CONTRACT_VERSION,
                    "semanticEpochId": EPOCH_ID,
                    "reportDigest": REPORT_DIGEST,
                    "report": report(),
                    "skipEvidence": {"projectId": PROJECT_ID}
                })
                .to_string(),
                RUN_ID
            ],
        )?;
        Ok(())
    })
    .expect("tamper stored evidence");
    let rejected = db
        .with_conn(|conn| read_completed_run_skip_evidence(conn, PROJECT_ID, "dependency-verify"))
        .expect("read tampered evidence");
    assert_eq!(rejected, None);
}

#[test]
fn rebuild_summary_evidence_uses_the_same_fail_closed_skip_contract() {
    let db = fixture_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, completed_at,
                 version, run_kind, semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'spec', 'completed', '{}', ?3,
                     datetime('now'), datetime('now'), 0, 'semantic-index-rebuild', ?4,
                     'dependency-rebuild-derived')",
            params![
                REBUILD_RUN_ID,
                PROJECT_ID,
                json!({
                    "rebuildContractVersion": "1",
                    "semanticEpochId": EPOCH_ID,
                    "summaryDigest": REBUILD_REPORT_DIGEST,
                    "summary": {}
                })
                .to_string(),
                EPOCH_ID,
            ],
        )?;
        Ok(())
    })
    .expect("insert rebuild run");
    persist_completed_run_skip_evidence(&db, REBUILD_RUN_ID, &rebuild_evidence())
        .expect("persist rebuild skip evidence");

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &rebuild_expectation()))
        .expect("evaluate rebuild skip");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Skip {
            run_id: REBUILD_RUN_ID.to_string(),
            report_digest: REBUILD_REPORT_DIGEST.to_string(),
        }
    );
}

#[test]
fn every_contract_coordinate_is_a_skip_boundary() {
    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(successful_outcome()));
    persist_completed_run_skip_evidence(&db, RUN_ID, &evidence()).expect("persist skip evidence");

    let cases = [
        (
            "semantic_epoch_id",
            "epoch-rotated",
            CompletedRunSkipReason::EpochMismatch,
        ),
        (
            "graph_contract_digest",
            "sha256:graph-contract-2",
            CompletedRunSkipReason::GraphContractMismatch,
        ),
        (
            "rule_registry_digest",
            "sha256:rule-registry-2",
            CompletedRunSkipReason::RuleRegistryMismatch,
        ),
        (
            "producer_generation_set_digest",
            "sha256:producer-generations-2",
            CompletedRunSkipReason::ProducerGenerationMismatch,
        ),
        (
            "run_kind_contract_version",
            "4",
            CompletedRunSkipReason::RunKindContractMismatch,
        ),
    ];
    for (field, value, reason) in cases {
        let mut current = expectation();
        match field {
            "semantic_epoch_id" => current.semantic_epoch_id = value.to_string(),
            "graph_contract_digest" => current.graph_contract_digest = value.to_string(),
            "rule_registry_digest" => current.rule_registry_digest = value.to_string(),
            "producer_generation_set_digest" => {
                current.producer_generation_set_digest = value.to_string()
            }
            "run_kind_contract_version" => current.run_kind_contract_version = value.to_string(),
            _ => unreachable!(),
        }
        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &current))
            .expect("evaluate mismatch");
        assert_eq!(decision, CompletedRunSkipDecision::Rerun { reason });
    }
}

#[test]
fn missing_or_non_successful_latest_run_never_falls_back_to_an_older_success() {
    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(successful_outcome()));
    persist_completed_run_skip_evidence(&db, RUN_ID, &evidence()).expect("persist skip evidence");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET id = 'run-old-success', created_at = '2026-08-20T00:00:00.000Z'
              WHERE id = ?1",
            [RUN_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, version, run_kind, semantic_epoch_id,
                 work_key)
             VALUES ('run-new-failed', ?1, 'maintenance', '{}', '{}', 'spec', 'failed', '{}',
                     '2026-08-20T00:00:00.000Z', 0, 'dependency-verify', ?2, ?3)",
            params![
                PROJECT_ID,
                EPOCH_ID,
                format!("dependency-verify:{EPOCH_ID}")
            ],
        )?;
        Ok(())
    })
    .expect("insert newer failed run");

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
        .expect("evaluate failed latest run");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::LatestRunNotSuccessful,
        }
    );
}

#[test]
fn malformed_missing_and_tampered_report_evidence_fail_closed() {
    let cases = [
        (None, CompletedRunSkipReason::EvidenceMissing),
        (
            Some(json!({"semanticEpochId": EPOCH_ID})),
            CompletedRunSkipReason::EvidenceMalformed,
        ),
        (
            Some(json!({
                "projectId": PROJECT_ID,
                "runKind": "dependency-verify",
                "semanticEpochId": EPOCH_ID,
                "graphContractDigest": GRAPH_DIGEST,
                "ruleRegistryDigest": RULE_DIGEST,
                "producerGenerationSetDigest": PRODUCER_DIGEST,
                "runKindContractVersion": "4",
                "reportDigest": REPORT_DIGEST,
            })),
            CompletedRunSkipReason::RunKindContractMismatch,
        ),
        (
            Some(json!({
                "projectId": PROJECT_ID,
                "runKind": "dependency-verify",
                "semanticEpochId": EPOCH_ID,
                "graphContractDigest": GRAPH_DIGEST,
                "ruleRegistryDigest": RULE_DIGEST,
                "producerGenerationSetDigest": PRODUCER_DIGEST,
                "runKindContractVersion": RUN_CONTRACT_VERSION,
                "reportDigest": "sha256:tampered",
            })),
            CompletedRunSkipReason::ReportDigestMismatch,
        ),
    ];
    for (outcome_evidence, expected_reason) in cases {
        let db = fixture_db();
        let mut outcome = successful_outcome();
        if let Some(value) = outcome_evidence {
            outcome["skipEvidence"] = value;
        }
        insert_completed_verify_run(&db, "completed", Some(outcome));
        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
            .expect("evaluate malformed evidence");
        assert_eq!(
            decision,
            CompletedRunSkipDecision::Rerun {
                reason: expected_reason
            }
        );
    }
}

#[test]
fn tampered_report_body_with_the_old_digest_forces_a_rerun() {
    let db = fixture_db();
    let mut outcome = successful_outcome();
    outcome["report"] = json!({
        "totalEdges": 99,
        "edgeIdsWithMissingSource": []
    });
    outcome["skipEvidence"] = serde_json::to_value(evidence()).expect("evidence json");
    insert_completed_verify_run(&db, "completed", Some(outcome));

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
        .expect("evaluate tampered report");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::ReportDigestMismatch
        }
    );
}

#[test]
fn old_outcome_contract_version_forces_a_rerun_even_with_current_evidence() {
    let db = fixture_db();
    let mut outcome = successful_outcome();
    outcome["verifyContractVersion"] = json!("4");
    outcome["skipEvidence"] = serde_json::to_value(evidence()).expect("evidence json");
    insert_completed_verify_run(&db, "completed", Some(outcome));

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
        .expect("evaluate old contract");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::RunKindContractMismatch
        }
    );
}

#[test]
fn failed_terminal_and_missing_report_digest_cannot_be_sealed_as_skip_evidence() {
    let db = fixture_db();
    insert_completed_verify_run(
        &db,
        "completed",
        Some(json!({
            "verifyContractVersion": RUN_CONTRACT_VERSION,
            "semanticEpochId": EPOCH_ID,
            "report": report(),
        })),
    );
    let error = persist_completed_run_skip_evidence(&db, RUN_ID, &evidence())
        .expect_err("missing report digest must not be sealed");
    assert!(error.to_string().contains("report digest"));
}
