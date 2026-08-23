//! C2-5B-B contract-aware completed-Run skip evidence.
//!
//! These tests exercise only the durable evidence reader/writer and its
//! fail-closed decision. They do not start the Electron scheduler or any
//! Verify/Rebuild production trigger.

use grimodex_db::narrative_extraction::maintenance_skip_evidence::{
    evaluate_completed_run_skip, persist_completed_run_skip_evidence,
    persist_completed_run_skip_evidence_in_tx, read_completed_run_skip_evidence,
    CompletedRunSkipDecision, CompletedRunSkipEvidence, CompletedRunSkipExpectation,
    CompletedRunSkipReason,
};
use grimodex_db::narrative_extraction::{digest_plan, ensure_test_schema};
use grimodex_db::Database;
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::Path;

const PROJECT_ID: &str = "project-c2-5b-b";
const EPOCH_ID: &str = "epoch-c2-5b-b";
const RUN_ID: &str = "run-c2-5b-b";
const GRAPH_DIGEST: &str =
    "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const RULE_DIGEST: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const PRODUCER_DIGEST: &str =
    "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const RUN_CONTRACT_VERSION: &str = "6";
const REBUILD_RUN_ID: &str = "run-c2-5b-b-rebuild";

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
    json!({
        "totalEdges": 0,
        "edgeIdsWithMissingSource": [],
        "duplicateEdgeKeys": [],
        "edgeIdsWithCrossProjectConsumer": [],
        "edgeIdsWithMalformedKeys": [],
        "edgeStateIdsOutsideCurrentEpoch": [],
        "edgeIdsWithoutCurrentEpochState": [],
        "findingObservationIdsOutsideCurrentEpoch": [],
        "consumerKeysWithoutCurrentEpochFreshness": [],
        "duplicateEdgeIdsToDeactivate": [],
        "edgeIdsWithUnresolvableConsumerScope": [],
        "consumerKeysWithStaleDependencySetDigest": [],
        "consumerKeysWithUncomputedDependencySetDigest": [],
        "orphanedAttentionFindingKeys": [],
        "orphanedAttentionRehomeAmbiguities": [],
        "rebuildRequired": false
    })
}

fn report_digest() -> String {
    format!("sha256:{}", digest_plan(&report()))
}

fn rebuild_summary() -> serde_json::Value {
    json!({
        "consumersEvaluated": 0,
        "edgesEvaluated": 0,
        "consumersSkippedUnresolvableScope": 0,
        "edgesSkippedUnresolvableScope": 0
    })
}

fn rebuild_report_digest() -> String {
    format!("sha256:{}", digest_plan(&rebuild_summary()))
}

fn evidence() -> CompletedRunSkipEvidence {
    CompletedRunSkipEvidence {
        project_id: PROJECT_ID.to_string(),
        run_kind: "dependency-verify".to_string(),
        work_key: format!("dependency-verify:{EPOCH_ID}"),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: RUN_CONTRACT_VERSION.to_string(),
        report_digest: report_digest(),
    }
}

fn expectation() -> CompletedRunSkipExpectation {
    CompletedRunSkipExpectation {
        project_id: PROJECT_ID.to_string(),
        run_kind: "dependency-verify".to_string(),
        work_key: format!("dependency-verify:{EPOCH_ID}"),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: RUN_CONTRACT_VERSION.to_string(),
        report_digest: Some(report_digest()),
    }
}

fn rebuild_evidence() -> CompletedRunSkipEvidence {
    CompletedRunSkipEvidence {
        project_id: PROJECT_ID.to_string(),
        run_kind: "semantic-index-rebuild".to_string(),
        work_key: "dependency-rebuild-derived".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: "1".to_string(),
        report_digest: rebuild_report_digest(),
    }
}

fn rebuild_expectation() -> CompletedRunSkipExpectation {
    CompletedRunSkipExpectation {
        project_id: PROJECT_ID.to_string(),
        run_kind: "semantic-index-rebuild".to_string(),
        work_key: "dependency-rebuild-derived".to_string(),
        semantic_epoch_id: EPOCH_ID.to_string(),
        graph_contract_digest: GRAPH_DIGEST.to_string(),
        rule_registry_digest: RULE_DIGEST.to_string(),
        producer_generation_set_digest: PRODUCER_DIGEST.to_string(),
        run_kind_contract_version: "1".to_string(),
        report_digest: Some(rebuild_report_digest()),
    }
}

fn insert_completed_verify_run(db: &Database, status: &str, outcome: Option<serde_json::Value>) {
    insert_verify_run_with_metadata(
        db,
        RUN_ID,
        status,
        outcome,
        "2026-08-22T00:00:00.000Z",
        if status == "completed" {
            Some("2026-08-22T00:00:00.000Z")
        } else {
            None
        },
        EPOCH_ID,
        &format!("dependency-verify:{EPOCH_ID}"),
    );
}

#[allow(clippy::too_many_arguments)]
fn insert_verify_run_with_metadata(
    db: &Database,
    run_id: &str,
    status: &str,
    outcome: Option<serde_json::Value>,
    created_at: &str,
    completed_at: Option<&str>,
    semantic_epoch_id: &str,
    work_key: &str,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, completed_at,
                 version, run_kind, semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'spec', ?3, '{}', ?4,
                     ?5, ?6, 0, 'dependency-verify', ?7, ?8)",
            params![
                run_id,
                PROJECT_ID,
                status,
                outcome.map(|value| value.to_string()),
                created_at,
                completed_at,
                semantic_epoch_id,
                work_key,
            ],
        )?;
        Ok(())
    })
    .expect("insert run");
}

#[allow(clippy::too_many_arguments)]
fn insert_rebuild_run_with_metadata(
    db: &Database,
    run_id: &str,
    status: &str,
    outcome: Option<serde_json::Value>,
    created_at: &str,
    completed_at: Option<&str>,
    semantic_epoch_id: &str,
    work_key: &str,
) {
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, outcome_summary_json, created_at, completed_at,
                 version, run_kind, semantic_epoch_id, work_key)
             VALUES (?1, ?2, 'maintenance', '{}', '{}', 'spec', ?3, '{}', ?4,
                     ?5, ?6, 0, 'semantic-index-rebuild', ?7, ?8)",
            params![
                run_id,
                PROJECT_ID,
                status,
                outcome.map(|value| value.to_string()),
                created_at,
                completed_at,
                semantic_epoch_id,
                work_key,
            ],
        )?;
        Ok(())
    })
    .expect("insert rebuild run");
}

fn successful_outcome() -> serde_json::Value {
    json!({
        "verifyContractVersion": RUN_CONTRACT_VERSION,
        "semanticEpochId": EPOCH_ID,
        "reportDigest": report_digest(),
        "report": report(),
    })
}

fn raw_outcome_summary_json(db: &Database, run_id: &str) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
            [run_id],
            |row| row.get(0),
        )?)
    })
    .expect("read raw outcome")
}

fn minimal_run_connection(path: &Path) -> Connection {
    let conn = Connection::open(path).expect("open concurrency fixture");
    conn.busy_timeout(std::time::Duration::from_millis(100))
        .expect("set busy timeout");
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         CREATE TABLE IF NOT EXISTS narrative_extraction_runs (
             id TEXT PRIMARY KEY,
             project_id TEXT NOT NULL,
             run_kind TEXT NOT NULL,
             status TEXT NOT NULL,
             semantic_epoch_id TEXT,
             work_key TEXT,
             completed_at TEXT,
             outcome_summary_json TEXT,
             version INTEGER NOT NULL
         );",
    )
    .expect("create concurrency fixture");
    conn
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
            report_digest: report_digest(),
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
                    "reportDigest": report_digest(),
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
fn verify_skip_evidence_requires_a_current_rebuild_contract_coordinate() {
    for (label, rebuild_contract_version) in [
        ("missing", None),
        ("old", Some("0")),
    ] {
        let db = fixture_db();
        let mut stored_evidence = serde_json::to_value(evidence()).expect("evidence json");
        let evidence_object = stored_evidence
            .as_object_mut()
            .expect("evidence must serialize as an object");
        match rebuild_contract_version {
            Some(version) => {
                evidence_object.insert(
                    "rebuildContractVersion".to_string(),
                    json!(version),
                );
            }
            None => {
                evidence_object.remove("rebuildContractVersion");
            }
        }
        let mut outcome = successful_outcome();
        outcome["skipEvidence"] = stored_evidence;
        insert_completed_verify_run(&db, "completed", Some(outcome));

        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
            .expect("evaluate stale rebuild coordinate");
        assert!(
            matches!(decision, CompletedRunSkipDecision::Rerun { .. }),
            "{label} Rebuild contract coordinate must invalidate Verify skip evidence"
        );
    }
}

#[test]
fn equal_maximal_verify_created_at_is_ambiguous_regardless_of_run_id_order() {
    for (successful_id, failed_id) in [
        ("verify-success-a", "verify-failed-z"),
        ("verify-success-z", "verify-failed-a"),
    ] {
        let db = fixture_db();
        let created_at = "2026-08-23T00:00:00.000Z";
        let completed_at = Some("2026-08-23T00:00:01.000Z");
        insert_verify_run_with_metadata(
            &db,
            successful_id,
            "completed",
            Some(successful_outcome()),
            created_at,
            completed_at,
            EPOCH_ID,
            &format!("dependency-verify:{EPOCH_ID}"),
        );
        insert_verify_run_with_metadata(
            &db,
            failed_id,
            "failed",
            None,
            created_at,
            completed_at,
            EPOCH_ID,
            &format!("dependency-verify:{EPOCH_ID}"),
        );
        persist_completed_run_skip_evidence(&db, successful_id, &evidence())
            .expect("seal the successful Verify evidence");

        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
            .expect("evaluate equal-timestamp Verify candidates");
        assert_eq!(
            decision,
            CompletedRunSkipDecision::Rerun {
                reason: CompletedRunSkipReason::AmbiguousLifecycle,
            },
            "run-id ordering must never decide which equal-timestamp terminal wins"
        );
    }
}

#[test]
fn idempotent_persist_preserves_unknown_fields_and_terminal_digest_aliases() {
    for alias in ["successfulTerminalDigest", "terminalDigest"] {
        let db = fixture_db();
        let mut outcome = successful_outcome();
        let mut stored_evidence = serde_json::to_value(evidence()).expect("evidence json");
        let digest = stored_evidence
            .as_object_mut()
            .expect("evidence object")
            .remove("reportDigest")
            .expect("canonical report digest");
        let object = stored_evidence.as_object_mut().expect("evidence object");
        object.insert(
            "futureEvidenceField".to_string(),
            json!({"schema": 2, "preserve": true}),
        );
        object.insert(alias.to_string(), digest);
        outcome["skipEvidence"] = stored_evidence;
        insert_completed_verify_run(&db, "completed", Some(outcome));
        let before = raw_outcome_summary_json(&db, RUN_ID);

        persist_completed_run_skip_evidence(&db, RUN_ID, &evidence())
            .expect("semantic equality must be idempotent");

        assert_eq!(raw_outcome_summary_json(&db, RUN_ID), before);
        assert_eq!(
            db.with_conn(|conn| read_completed_run_skip_evidence(
                conn,
                PROJECT_ID,
                "dependency-verify"
            ))
            .expect("read aliased evidence"),
            Some(evidence())
        );
    }
}

#[test]
fn known_evidence_mismatch_conflicts_without_rewriting_forward_fields() {
    let db = fixture_db();
    let mut outcome = successful_outcome();
    let mut stored_evidence = serde_json::to_value(evidence()).expect("evidence json");
    let object = stored_evidence.as_object_mut().expect("evidence object");
    object.insert(
        "futureEvidenceField".to_string(),
        json!({"schema": 2, "preserve": true}),
    );
    let digest = object
        .remove("reportDigest")
        .expect("canonical report digest");
    object.insert("successfulTerminalDigest".to_string(), digest);
    outcome["skipEvidence"] = stored_evidence;
    insert_completed_verify_run(&db, "completed", Some(outcome));
    let before = raw_outcome_summary_json(&db, RUN_ID);

    let mut mismatched = evidence();
    mismatched.graph_contract_digest =
        "sha256:4444444444444444444444444444444444444444444444444444444444444444".to_string();
    let error = persist_completed_run_skip_evidence(&db, RUN_ID, &mismatched)
        .expect_err("known coordinate mismatch must conflict");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_SKIP_EVIDENCE_CONFLICT"));
    assert_eq!(raw_outcome_summary_json(&db, RUN_ID), before);
}

#[test]
fn in_tx_persistence_rejects_an_autocommit_connection() {
    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(successful_outcome()));
    let error = db
        .with_conn(|conn| persist_completed_run_skip_evidence_in_tx(conn, RUN_ID, &evidence()))
        .expect_err("in-tx API must require a caller-owned transaction");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_SKIP_TRANSACTION_REQUIRED"));
}

#[test]
fn in_tx_persistence_does_not_overwrite_a_concurrent_outcome_mutation() {
    let path = std::env::temp_dir().join(format!(
        "grimodex-skip-evidence-concurrency-{}.db",
        uuid::Uuid::new_v4()
    ));
    let conn = minimal_run_connection(&path);
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, run_kind, status, semantic_epoch_id, work_key,
             completed_at, outcome_summary_json, version)
         VALUES (?1, ?2, 'dependency-verify', 'completed', ?3, ?4, ?5, ?6, 0)",
        params![
            RUN_ID,
            PROJECT_ID,
            EPOCH_ID,
            format!("dependency-verify:{EPOCH_ID}"),
            "2026-08-22T00:00:00.000Z",
            successful_outcome().to_string(),
        ],
    )
    .expect("insert concurrency run");
    conn.execute_batch("BEGIN")
        .expect("begin deferred caller transaction");
    let _: String = conn
        .query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .expect("establish caller snapshot");

    let concurrent = minimal_run_connection(&path);
    let mut mutated_outcome = successful_outcome();
    mutated_outcome["concurrentMutation"] = json!(true);
    concurrent
        .execute(
            "UPDATE narrative_extraction_runs
                SET outcome_summary_json = ?1, version = version + 1
              WHERE id = ?2",
            params![mutated_outcome.to_string(), RUN_ID],
        )
        .expect("mutate outcome concurrently");
    drop(concurrent);

    let error = persist_completed_run_skip_evidence_in_tx(&conn, RUN_ID, &evidence())
        .expect_err("stale caller snapshot must not overwrite concurrent mutation");
    assert!(error
        .to_string()
        .contains("NEX_MAINTENANCE_SKIP_EVIDENCE_LOST"));
    conn.execute_batch("ROLLBACK")
        .expect("rollback stale caller transaction");
    drop(conn);

    let observed = minimal_run_connection(&path);
    let stored: String = observed
        .query_row(
            "SELECT outcome_summary_json FROM narrative_extraction_runs WHERE id = ?1",
            [RUN_ID],
            |row| row.get(0),
        )
        .expect("read concurrent outcome");
    let stored: serde_json::Value = serde_json::from_str(&stored).expect("parse outcome");
    assert_eq!(stored.get("concurrentMutation"), Some(&json!(true)));
    assert!(stored.get("skipEvidence").is_none());
    drop(observed);
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(path.with_extension("db-wal"));
    let _ = std::fs::remove_file(path.with_extension("db-shm"));
}

#[test]
fn completed_rebuild_runs_are_never_reused_by_the_skip_contract() {
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
                    "summaryDigest": rebuild_report_digest(),
                    "summary": rebuild_summary()
                })
                .to_string(),
                EPOCH_ID,
            ],
        )?;
        Ok(())
    })
    .expect("insert rebuild run");
    assert!(persist_completed_run_skip_evidence(&db, REBUILD_RUN_ID, &rebuild_evidence()).is_err());

    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &rebuild_expectation()))
        .expect("evaluate rebuild skip");
    assert_eq!(
        decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::UnsupportedRunKind,
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
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            CompletedRunSkipReason::GraphContractMismatch,
        ),
        (
            "rule_registry_digest",
            "sha256:5555555555555555555555555555555555555555555555555555555555555555",
            CompletedRunSkipReason::RuleRegistryMismatch,
        ),
        (
            "producer_generation_set_digest",
            "sha256:6666666666666666666666666666666666666666666666666666666666666666",
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
            "semantic_epoch_id" => {
                current.semantic_epoch_id = value.to_string();
                current.work_key = format!("dependency-verify:{value}");
            }
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
             VALUES ('run-z-failed', ?1, 'maintenance', '{}', '{}', 'spec', 'failed', '{}',
                     '2026-08-20T00:00:01.000Z', 0, 'dependency-verify', ?2, ?3)",
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
                "workKey": format!("dependency-verify:{EPOCH_ID}"),
                "semanticEpochId": EPOCH_ID,
                "graphContractDigest": GRAPH_DIGEST,
                "ruleRegistryDigest": RULE_DIGEST,
                "producerGenerationSetDigest": PRODUCER_DIGEST,
                "runKindContractVersion": "4",
                "reportDigest": report_digest(),
            })),
            CompletedRunSkipReason::RunKindContractMismatch,
        ),
        (
            Some(json!({
                "projectId": PROJECT_ID,
                "runKind": "dependency-verify",
                "workKey": format!("dependency-verify:{EPOCH_ID}"),
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
    outcome["report"] = {
        let mut value = report();
        value["totalEdges"] = json!(99);
        value
    };
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

fn assert_verify_shape_rejected(report_value: serde_json::Value) {
    let digest = format!("sha256:{}", digest_plan(&report_value));
    let mut outcome = successful_outcome();
    outcome["report"] = report_value;
    outcome["reportDigest"] = json!(digest);
    let mut stored_evidence = evidence();
    stored_evidence.report_digest = digest.clone();
    outcome["skipEvidence"] = serde_json::to_value(stored_evidence.clone()).expect("evidence");

    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(outcome));
    let mut current = expectation();
    current.report_digest = Some(digest);
    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &current))
        .expect("evaluate malformed Verify shape");
    assert!(matches!(decision, CompletedRunSkipDecision::Rerun { .. }));
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "dependency-verify"
        ))
        .expect("read malformed Verify shape"),
        None
    );
    assert!(persist_completed_run_skip_evidence(&db, RUN_ID, &stored_evidence).is_err());
}

fn assert_rebuild_shape_rejected(summary_value: serde_json::Value) {
    let digest = format!("sha256:{}", digest_plan(&summary_value));
    let outcome = json!({
        "rebuildContractVersion": "1",
        "semanticEpochId": EPOCH_ID,
        "summaryDigest": digest,
        "summary": summary_value,
    });
    let mut stored_evidence = rebuild_evidence();
    stored_evidence.report_digest = digest.clone();
    let mut outcome = outcome;
    outcome["skipEvidence"] = serde_json::to_value(stored_evidence.clone()).expect("evidence");

    let db = fixture_db();
    insert_rebuild_run_with_metadata(
        &db,
        REBUILD_RUN_ID,
        "completed",
        Some(outcome),
        "2026-08-22T00:00:00.000Z",
        Some("2026-08-22T00:00:00.000Z"),
        EPOCH_ID,
        "dependency-rebuild-derived",
    );
    let mut current = rebuild_expectation();
    current.report_digest = Some(digest);
    let decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &current))
        .expect("evaluate malformed Rebuild shape");
    assert!(matches!(decision, CompletedRunSkipDecision::Rerun { .. }));
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "semantic-index-rebuild"
        ))
        .expect("read malformed Rebuild shape"),
        None
    );
    assert!(persist_completed_run_skip_evidence(&db, REBUILD_RUN_ID, &stored_evidence).is_err());
}

#[test]
fn verify_report_required_fields_and_types_are_fail_closed() {
    let mut missing = report();
    missing
        .as_object_mut()
        .expect("report object")
        .remove("edgeIdsWithMissingSource");
    assert_verify_shape_rejected(missing);

    let mut wrong_type = report();
    wrong_type["totalEdges"] = json!("0");
    assert_verify_shape_rejected(wrong_type);
}

#[test]
fn rebuild_summary_required_fields_and_types_are_fail_closed() {
    let mut missing = rebuild_summary();
    missing
        .as_object_mut()
        .expect("summary object")
        .remove("edgesEvaluated");
    assert_rebuild_shape_rejected(missing);

    let mut wrong_type = rebuild_summary();
    wrong_type["edgesEvaluated"] = json!("0");
    assert_rebuild_shape_rejected(wrong_type);
}

#[test]
fn outcome_epoch_mismatch_is_rejected_for_verify_and_rebuild() {
    let db = fixture_db();
    let mut verify_outcome = successful_outcome();
    verify_outcome["semanticEpochId"] = json!("epoch-outcome-mismatch");
    verify_outcome["skipEvidence"] = serde_json::to_value(evidence()).expect("evidence");
    insert_completed_verify_run(&db, "completed", Some(verify_outcome));
    let verify_decision = db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
        .expect("evaluate Verify epoch mismatch");
    assert_eq!(
        verify_decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::EpochMismatch
        }
    );
    assert!(persist_completed_run_skip_evidence(&db, RUN_ID, &evidence()).is_err());
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "dependency-verify"
        ))
        .expect("read Verify epoch mismatch"),
        None
    );

    let rebuild_db = fixture_db();
    let rebuild_outcome = json!({
        "rebuildContractVersion": "1",
        "semanticEpochId": "epoch-outcome-mismatch",
        "summaryDigest": rebuild_report_digest(),
        "summary": rebuild_summary(),
        "skipEvidence": rebuild_evidence(),
    });
    insert_rebuild_run_with_metadata(
        &rebuild_db,
        REBUILD_RUN_ID,
        "completed",
        Some(rebuild_outcome),
        "2026-08-22T00:00:00.000Z",
        Some("2026-08-22T00:00:00.000Z"),
        EPOCH_ID,
        "dependency-rebuild-derived",
    );
    let rebuild_decision = rebuild_db
        .with_conn(|conn| evaluate_completed_run_skip(conn, &rebuild_expectation()))
        .expect("evaluate Rebuild epoch mismatch");
    assert_eq!(
        rebuild_decision,
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::UnsupportedRunKind
        }
    );
    assert!(
        persist_completed_run_skip_evidence(&rebuild_db, REBUILD_RUN_ID, &rebuild_evidence())
            .is_err()
    );
    assert_eq!(
        rebuild_db
            .with_conn(|conn| read_completed_run_skip_evidence(
                conn,
                PROJECT_ID,
                "semantic-index-rebuild"
            ))
            .expect("read Rebuild epoch mismatch"),
        None
    );
}

#[test]
fn read_binds_run_identity_epoch_and_canonical_work_key_to_evidence() {
    let db = fixture_db();
    insert_completed_verify_run(&db, "completed", Some(successful_outcome()));
    persist_completed_run_skip_evidence(&db, RUN_ID, &evidence()).expect("persist evidence");

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET semantic_epoch_id = NULL, work_key = 'non-canonical'
              WHERE id = ?1",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("tamper Run coordinates");
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "dependency-verify"
        ))
        .expect("read mismatched Run coordinates"),
        None
    );

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET semantic_epoch_id = ?1, work_key = ?2, run_kind = 'semantic-index-rebuild'
              WHERE id = ?3",
            params![EPOCH_ID, "dependency-rebuild-derived", RUN_ID],
        )?;
        Ok(())
    })
    .expect("tamper Run kind");
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "semantic-index-rebuild"
        ))
        .expect("read mismatched Run kind"),
        None
    );

    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-other', 'other')",
            [],
        )?;
        conn.execute(
            "UPDATE narrative_extraction_runs SET project_id = 'project-other' WHERE id = ?1",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("tamper Run project");
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            "project-other",
            "semantic-index-rebuild"
        ))
        .expect("read mismatched Run project"),
        None
    );
}

#[test]
fn created_at_controls_latest_run_and_equal_timestamps_fail_closed() {
    let db = fixture_db();
    insert_verify_run_with_metadata(
        &db,
        "run-failed-newer",
        "failed",
        None,
        "2026-08-23T00:00:00.000Z",
        None,
        EPOCH_ID,
        &format!("dependency-verify:{EPOCH_ID}"),
    );
    insert_verify_run_with_metadata(
        &db,
        "run-success-older",
        "completed",
        Some(successful_outcome()),
        "2026-08-22T00:00:00.000Z",
        Some("2026-08-22T00:00:00.000Z"),
        EPOCH_ID,
        &format!("dependency-verify:{EPOCH_ID}"),
    );
    persist_completed_run_skip_evidence(&db, "run-success-older", &evidence())
        .expect("persist older success");
    assert_eq!(
        db.with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
            .expect("evaluate timestamp ordering"),
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::LatestRunNotSuccessful
        }
    );
    assert_eq!(
        db.with_conn(|conn| read_completed_run_skip_evidence(
            conn,
            PROJECT_ID,
            "dependency-verify"
        ))
        .expect("read timestamp ordering"),
        None
    );

    let tie_db = fixture_db();
    let same_created_at = "2026-08-22T00:00:00.000Z";
    insert_verify_run_with_metadata(
        &tie_db,
        "run-z-failed",
        "failed",
        None,
        same_created_at,
        None,
        EPOCH_ID,
        &format!("dependency-verify:{EPOCH_ID}"),
    );
    insert_verify_run_with_metadata(
        &tie_db,
        "run-a-success",
        "completed",
        Some(successful_outcome()),
        same_created_at,
        Some(same_created_at),
        EPOCH_ID,
        &format!("dependency-verify:{EPOCH_ID}"),
    );
    persist_completed_run_skip_evidence(&tie_db, "run-a-success", &evidence())
        .expect("persist tie success");
    assert_eq!(
        tie_db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &expectation()))
            .expect("evaluate same-created ordering"),
        CompletedRunSkipDecision::Rerun {
            reason: CompletedRunSkipReason::AmbiguousLifecycle
        }
    );
    assert_eq!(
        tie_db
            .with_conn(|conn| read_completed_run_skip_evidence(
                conn,
                PROJECT_ID,
                "dependency-verify"
            ))
            .expect("read same-created ordering"),
        None
    );
}

#[test]
fn every_digest_coordinate_requires_sha256_lowercase_hex64() {
    let invalid_values = [
        "sha256:short",
        "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "sha256:000000000000000000000000000000000000000000000000000000000000000g",
        "sha512:0000000000000000000000000000000000000000000000000000000000000000",
    ];
    for (field, invalid) in [
        ("graphContractDigest", invalid_values[0]),
        ("ruleRegistryDigest", invalid_values[1]),
        ("producerGenerationSetDigest", invalid_values[2]),
        ("reportDigest", invalid_values[3]),
    ] {
        let db = fixture_db();
        let mut stored_evidence = evidence();
        match field {
            "graphContractDigest" => stored_evidence.graph_contract_digest = invalid.to_string(),
            "ruleRegistryDigest" => stored_evidence.rule_registry_digest = invalid.to_string(),
            "producerGenerationSetDigest" => {
                stored_evidence.producer_generation_set_digest = invalid.to_string()
            }
            "reportDigest" => stored_evidence.report_digest = invalid.to_string(),
            _ => unreachable!(),
        }
        let mut outcome = successful_outcome();
        outcome["skipEvidence"] = serde_json::to_value(&stored_evidence).expect("evidence");
        insert_completed_verify_run(&db, "completed", Some(outcome));
        let mut current = expectation();
        match field {
            "graphContractDigest" => current.graph_contract_digest = invalid.to_string(),
            "ruleRegistryDigest" => current.rule_registry_digest = invalid.to_string(),
            "producerGenerationSetDigest" => {
                current.producer_generation_set_digest = invalid.to_string()
            }
            "reportDigest" => current.report_digest = Some(invalid.to_string()),
            _ => unreachable!(),
        }
        let decision = db
            .with_conn(|conn| evaluate_completed_run_skip(conn, &current))
            .expect("evaluate invalid digest coordinate");
        assert!(matches!(decision, CompletedRunSkipDecision::Rerun { .. }));
        assert_eq!(
            db.with_conn(|conn| read_completed_run_skip_evidence(
                conn,
                PROJECT_ID,
                "dependency-verify"
            ))
            .expect("read invalid digest coordinate"),
            None
        );
        assert!(persist_completed_run_skip_evidence(&db, RUN_ID, &stored_evidence).is_err());
    }
}
