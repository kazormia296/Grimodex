//! C2-ZC public cutover contract (RED on the frozen C2-ZB base).
//!
//! These tests intentionally describe the externally visible boundary before
//! the canonical-authority implementation exists.  They do not exercise a
//! private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::path::Path;

use grimodex_db::narrative_extraction::{
    canonical_application_freshness, cut_over_workspace_freshness, digest_plan, ensure_test_schema,
    inspect_workspace_cutover_readiness_with_liveness, narrative_extraction_append_human_decision,
    narrative_extraction_apply_commit, narrative_extraction_create_run,
    narrative_extraction_prepare_commit, narrative_extraction_save_proposal_set,
    record_live_scheduler_heartbeat, run_incremental_freshness_cycle, AppendDecisionPayload,
    ApplyCommitPayload, CanonicalFreshnessAuthority, CommitApplicationRef, CommitOperation,
    CreateRunPayload, CreateTaskSeed, DependencyGraphVerifyReport, PrepareCommitPayload,
    ProposalSeed, ReadinessState, SaveProposalSetPayload, SchedulerLivenessEvidence,
    C2_ZC_CUTOVER_MIGRATION_ID, REBUILD_DERIVED_WORK_KEY, REQUIRED_VERIFY_CHECKS,
    VERIFY_WORK_KEY_PREFIX,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const PROJECT_ID: &str = "project-c2zc";
const EPOCH_ID: &str = "epoch-c2zc";
const APPLICATION_ID: &str = "application-c2zc";
const SOURCE_IDENTITY: &str = "project:scene:scene-c2zc";
const NOW: &str = "2026-08-24T00:00:00.000Z";
const BASELINE_RUN_ID: &str = "backfill-c2zc";
const BASELINE_VERIFY_RUN_ID: &str = "verify-c2zc";
const BASELINE_REBUILD_RUN_ID: &str = "rebuild-c2zc";
const BASELINE_FRESHNESS_RUN_ID: &str = "freshness-c2zc";

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'C2-ZC fixture')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES (?1, ?2, 0, 'initial', ?3)",
            params![EPOCH_ID, PROJECT_ID, NOW],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, node_type, title, content, version, updated_at)
             VALUES (?1, ?2, 'scene', 'C2-ZC scene', '{}', 0, ?3)",
            params!["scene-c2zc", PROJECT_ID, NOW],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed project");
    db
}

fn scheduler_evidence(project_ids: &[&str]) -> SchedulerLivenessEvidence {
    SchedulerLivenessEvidence {
        scheduler_instance_id: "scheduler-c2zc-red".to_string(),
        observed_at: NOW.to_string(),
        project_ids: project_ids.iter().map(|id| (*id).to_string()).collect(),
    }
}

#[test]
fn database_only_liveness_never_becomes_cutover_evidence() {
    let db = fixture_db();

    db.with_conn(|conn| {
        let durable = inspect_workspace_cutover_readiness_with_liveness(conn, None)?;
        assert!(!durable.ready);
        assert_eq!(durable.state, ReadinessState::Incomplete);
        assert!(durable
            .reasons
            .iter()
            .any(|reason| reason == "scheduler-liveness-evidence-required"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("readiness report");
}

#[test]
fn cutover_refuses_incomplete_workspace_before_any_authority_marker() {
    let db = fixture_db();

    let error = db
        .with_conn(|conn| {
            let error = cut_over_workspace_freshness(conn, &scheduler_evidence(&[PROJECT_ID]))
                .expect_err("incomplete durable gates must block C2-ZC");
            Ok::<_, anyhow::Error>(error)
        })
        .expect("read cutover error");

    assert!(error.to_string().contains("NEX_C2ZC_CUTOVER_NOT_READY"));
    db.with_conn(|conn| {
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 0);
        Ok::<_, anyhow::Error>(())
    })
    .expect("cutover must not write a marker when blocked");
}

#[test]
fn canonical_read_has_no_legacy_fallback_after_generic_cutover() {
    let db = fixture_db();

    db.with_conn(|conn| {
        // The RED fixture deliberately calls the public cutover API only
        // after a test-owned durable fixture has satisfied the full contract.
        seed_cutover_ready_application(conn)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed cutover fixture");
    let evidence = record_live_scheduler_heartbeat(&db, "c2zc-test-authority", 1)
        .expect("mint live scheduler receipt");
    db.with_conn(|conn| {
        let first = cut_over_workspace_freshness(conn, &evidence)?;
        let second = cut_over_workspace_freshness(conn, &evidence)?;
        assert_eq!(first, second, "cutover marker must be idempotent");

        conn.execute(
            "UPDATE narrative_projection_freshness
                SET status = 'source-missing'
              WHERE application_id = ?1",
            [APPLICATION_ID],
        )?;
        let read = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)?
            .expect("Generic Consumer Freshness row is the canonical read");
        assert_eq!(
            read.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(read.evidence_freshness, "fresh");
        let marker_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM schema_data_migrations WHERE migration_id = ?1",
            [C2_ZC_CUTOVER_MIGRATION_ID],
            |row| row.get(0),
        )?;
        assert_eq!(marker_count, 1);
        Ok::<_, anyhow::Error>(())
    })
    .expect("canonical read");
}

#[test]
fn canonical_read_fails_closed_when_generic_evidence_is_missing() {
    let db = fixture_db();

    db.with_conn(|conn| {
        seed_cutover_ready_application(conn)?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("seed cutover fixture");
    let evidence = record_live_scheduler_heartbeat(&db, "c2zc-test-authority", 2)
        .expect("mint live scheduler receipt");
    db.with_conn(|conn| {
        cut_over_workspace_freshness(conn, &evidence)?;
        conn.execute(
            "DELETE FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, APPLICATION_ID],
        )?;

        let error = canonical_application_freshness(conn, PROJECT_ID, APPLICATION_ID)
            .expect_err("missing Generic evidence must not fall back to Legacy");
        assert!(error
            .to_string()
            .contains("NEX_C2ZC_GENERIC_FRESHNESS_MISSING"));
        Ok::<_, anyhow::Error>(())
    })
    .expect("fail-closed canonical read");
}

fn seed_cutover_ready_application(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_apply_commits
            (id, project_id, run_id, request_id, plan_digest, status, created_at)
         VALUES ('commit-c2zc', ?1, ?2, 'request-c2zc', 'sha256:c2zc',
                 'committed', ?3)",
        params![PROJECT_ID, BASELINE_RUN_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_applications
            (id, commit_id, proposal_id, revision_id, applied_entity_kind,
             applied_entity_id, created_at)
         VALUES (?1, 'commit-c2zc', 'proposal-c2zc', 'revision-c2zc',
                 'codex-entry', 'entry-c2zc', ?2)",
        params![APPLICATION_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, completed_at, run_kind,
             semantic_epoch_id, work_key, outcome_summary_json)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'backfill-c2zc', 'completed',
                 '{}', ?3, ?3, 'backfill', ?4, 'legacy-dependency-backfill:v3', NULL)",
        params![BASELINE_RUN_ID, PROJECT_ID, NOW, EPOCH_ID],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_freshness
            (application_id, status, reason_json, version, updated_at)
         VALUES (?1, 'fresh', NULL, 0, ?2)",
        params![APPLICATION_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_projection_dependencies
            (application_id, source_kind, source_key, observed_revision_token, propagation)
         VALUES (?1, 'scene-body', ?2, 'token-c2zc', 'freshness-only')",
        params![APPLICATION_ID, SOURCE_IDENTITY],
    )?;
    conn.execute(
        "INSERT INTO narrative_consumer_freshness
            (project_id, consumer_kind, consumer_key, evidence_freshness,
             build_action, semantic_epoch_id, last_evaluated_run_id,
             dependency_set_digest, updated_at)
         VALUES (?1, 'application', ?2, 'fresh', 'none', ?3, NULL,
                 ?4, ?5)",
        params![
            PROJECT_ID,
            APPLICATION_ID,
            EPOCH_ID,
            dependency_set_digest(&[SOURCE_IDENTITY]),
            NOW
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_dependency_edges
            (id, project_id, consumer_kind, consumer_key, source_object_identity,
             read_set_json, created_at, owning_run_id)
         VALUES ('edge-c2zc', ?1, 'application', ?2, ?3,
                 '[\"token-c2zc\"]', ?4, ?5)",
        params![
            PROJECT_ID,
            APPLICATION_ID,
            SOURCE_IDENTITY,
            NOW,
            BASELINE_RUN_ID
        ],
    )?;

    let report = serde_json::to_value(DependencyGraphVerifyReport::default())?;
    let check_coverage = json!({
        "complete": true,
        "required": REQUIRED_VERIFY_CHECKS,
        "covered": REQUIRED_VERIFY_CHECKS,
        "missing": [],
    });
    let verify_outcome = json!({
        "verifyContractVersion": "7",
        "semanticEpochId": EPOCH_ID,
        "reportDigest": format!("sha256:{}", digest_plan(&report)),
        "report": report,
        "checkCoverage": check_coverage,
    });
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, completed_at,
             run_kind, semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'verify-c2zc', 'completed',
                 '{}', ?3, ?4, ?4, 'dependency-verify', ?5, ?6)",
        params![
            BASELINE_VERIFY_RUN_ID,
            PROJECT_ID,
            verify_outcome.to_string(),
            NOW,
            EPOCH_ID,
            format!("{VERIFY_WORK_KEY_PREFIX}{EPOCH_ID}")
        ],
    )?;

    let summary = json!({
        "consumersEvaluated": 1,
        "edgesEvaluated": 1,
        "consumersSkippedUnresolvableScope": 0,
        "edgesSkippedUnresolvableScope": 0,
    });
    let rebuild_outcome = json!({
        "rebuildContractVersion": "1",
        "semanticEpochId": EPOCH_ID,
        "summaryDigest": format!("sha256:{}", digest_plan(&summary)),
        "summary": summary,
    });
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, completed_at,
             run_kind, semantic_epoch_id, work_key)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'rebuild-c2zc', 'completed',
                 '{}', ?3, ?4, ?4, 'semantic-index-rebuild', ?5, ?6)",
        params![
            BASELINE_REBUILD_RUN_ID,
            PROJECT_ID,
            rebuild_outcome.to_string(),
            NOW,
            EPOCH_ID,
            REBUILD_DERIVED_WORK_KEY
        ],
    )?;

    let incremental_outcome = json!({
        "projectId": PROJECT_ID,
        "runId": BASELINE_FRESHNESS_RUN_ID,
        "fromSequenceExclusive": 0,
        "throughSequenceInclusive": 0,
        "affectedEdgeCount": 0,
        "affectedConsumerCount": 0,
        "hasMore": false,
    });
    conn.execute(
        "INSERT INTO narrative_change_cursors
            (project_id, consumer_id, acknowledged_through_sequence, updated_at)
         VALUES (?1, 'narrative-incremental-freshness/v1', 0, ?2)",
        params![PROJECT_ID, NOW],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, outcome_summary_json, created_at, completed_at,
             run_kind, semantic_epoch_id, work_key, consumer_id)
         VALUES (?1, ?2, 'maintenance', '{}', '{}', 'freshness-c2zc', 'completed',
                 '{}', ?3, ?4, ?4, 'freshness-evaluation', ?5, ?6,
                 'narrative-incremental-freshness/v1')",
        params![
            BASELINE_FRESHNESS_RUN_ID,
            PROJECT_ID,
            incremental_outcome.to_string(),
            NOW,
            EPOCH_ID,
            format!("incremental-freshness:{EPOCH_ID}:0:0:baseline")
        ],
    )?;
    Ok(())
}

fn dependency_set_digest(source_identities: &[&str]) -> String {
    let mut values = source_identities
        .iter()
        .map(|identity| (*identity).to_string())
        .collect::<Vec<_>>();
    values.sort();
    let canonical = values
        .iter()
        .map(|identity| format!("{}:{}\n", identity.len(), identity))
        .collect::<String>();
    hex::encode(Sha256::digest(canonical.as_bytes()))
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("load runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".to_string(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("enable manual apply");
}

fn prepared_event_payload() -> Value {
    json!({
        "eventId": "event-c2zc-prepared",
        "title": "C2-ZC prepared event",
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": "scene-c2zc",
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none"
    })
}

fn prepared_envelope(run_id: &str, task_id: &str) -> Value {
    let revision_token = format!("v0@{NOW}");
    let read_set = json!([{
        "inputRef": SOURCE_IDENTITY,
        "kind": "snapshot-document",
        "sourceKind": "scene-body",
        "revisionToken": revision_token,
    }]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "test.c2zc.prepared",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "chronicle.event",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "scene-body",
            "sourceKey": SOURCE_IDENTITY,
            "revisionToken": format!("v0@{NOW}"),
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", digest_plan(&json!([{
            "inputRef": SOURCE_IDENTITY,
            "kind": "snapshot-document",
            "sourceKind": "scene-body",
            "revisionToken": format!("v0@{NOW}"),
        }]))),
        "changeKind": "add"
    })
}

fn seed_prepared_application(db: &Database) -> (String, String, String, String) {
    let run_id = "run-c2zc-prepared";
    let task_id = "task-c2zc-prepared";
    let set_id = "set-c2zc-prepared";
    let proposal_id = "proposal-c2zc-prepared";
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: PROJECT_ID.to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-c2zc-prepared".to_string(),
            snapshot_digest: Some(format!("v0@{NOW}")),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create prepared source run");
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: "key-c2zc-prepared".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: prepared_event_payload(),
                reconciliation_envelope: Some(prepared_envelope(run_id, task_id)),
            }],
        },
    )
    .expect("save prepared proposal");
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("saved proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("saved revision id")
        .to_string();
    narrative_extraction_append_human_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_id: saved_proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("c2zc-test".to_string()),
        },
    )
    .expect("approve prepared proposal");
    (
        run_id.to_string(),
        set_id.to_string(),
        saved_proposal_id,
        revision_id,
    )
}

fn prepared_commit_payload(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: PROJECT_ID.to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: "request-c2zc-prepared".to_string(),
        plan_digest: "client-digest-ignored".to_string(),
        session_id: "session-c2zc-prepared".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: prepared_event_payload(),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        applications: vec![CommitApplicationRef {
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

#[test]
fn prepared_apply_feed_without_locator_evaluates_only_declared_application() {
    let db = fixture_db();
    db.with_conn(|conn| seed_cutover_ready_application(conn))
        .expect("seed all C2-ZA durable prerequisites");
    let evidence = record_live_scheduler_heartbeat(&db, "c2zc-apply-authority", 1)
        .expect("mint live scheduler heartbeat from production seam");
    db.with_conn(|conn| cut_over_workspace_freshness(conn, &evidence))
        .expect("activate Generic Consumer Freshness");
    enable_manual_apply(&db);

    let baseline_before: (Option<String>, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT last_evaluated_run_id, updated_at
                   FROM narrative_consumer_freshness
                  WHERE project_id = ?1 AND consumer_kind = 'application'
                    AND consumer_key = ?2",
                params![PROJECT_ID, APPLICATION_ID],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read baseline Generic row");

    let (run_id, set_id, proposal_id, revision_id) = seed_prepared_application(&db);
    let prepared = narrative_extraction_prepare_commit(
        &db,
        prepared_commit_payload(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare through public commit API");
    let applied = narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: PROJECT_ID.to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared commit id")
                .to_string(),
            request_id: "request-c2zc-prepared".to_string(),
            session_id: "session-c2zc-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply through public commit API");
    assert_eq!(applied["status"], "applied");

    let application_id: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_proposal_applications
                  WHERE commit_id = ?1",
                [applied["commitId"].as_str().expect("applied commit id")],
                |row| row.get(0),
            )?)
        })
        .expect("read applied Application id");
    assert_ne!(application_id, APPLICATION_ID);

    db.with_conn(|conn| {
        let generic_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, application_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            generic_count, 0,
            "Apply declares the Edge before evaluation"
        );
        let application_ids_json: String = conn.query_row(
            "SELECT t.application_ids_json
               FROM narrative_change_transactions t
              WHERE t.commit_id = ?1",
            [applied["commitId"].as_str().expect("commit id")],
            |row| row.get(0),
        )?;
        let application_ids: Vec<String> = serde_json::from_str(&application_ids_json)?;
        assert_eq!(application_ids, vec![application_id.clone()]);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify typed Application identity survived Feed transaction");

    let outcome = run_incremental_freshness_cycle(&db).expect("run incremental Feed cycle");
    let summary = match outcome {
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
            summary
        }
        other => panic!("Apply Feed must be processed, got {other:?}"),
    };
    assert_eq!(summary.affected_edge_count, 1);
    assert_eq!(summary.affected_consumer_count, 1);

    db.with_conn(|conn| {
        let canonical = canonical_application_freshness(conn, PROJECT_ID, &application_id)?
            .expect("new Application has a canonical Generic row after its Feed cycle");
        assert_eq!(
            canonical.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(canonical.semantic_epoch_id, EPOCH_ID);
        let baseline_after: (Option<String>, String) = conn.query_row(
            "SELECT last_evaluated_run_id, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, APPLICATION_ID],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(baseline_after, baseline_before);
        Ok::<_, anyhow::Error>(())
    })
    .expect("read canonical Generic result and check no unrelated evaluation");

    let restart = run_incremental_freshness_cycle(&db).expect("restart-safe idle cycle");
    assert!(matches!(
        restart,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));
}
