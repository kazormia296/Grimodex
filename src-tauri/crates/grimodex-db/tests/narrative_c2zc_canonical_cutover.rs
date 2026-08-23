//! C2-ZC public cutover contract (RED on the frozen C2-ZB base).
//!
//! These tests intentionally describe the externally visible boundary before
//! the canonical-authority implementation exists.  They do not exercise a
//! private helper or a schema re-key: the only allowed transition is a
//! runtime-owned cutover after all durable workspace evidence and an explicit
//! scheduler-liveness proof are present.

use std::path::Path;

use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
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
use grimodex_db::scene_body::{save_scene_body_bundle, SaveSceneBodyBundlePayload};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::{params, Connection};
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

type ConsumerFreshnessRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

type EdgeFreshnessRow = (String, String, Option<String>, String, String, String);

fn fixture_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        ensure_test_schema(conn)?;
        // `Database::migrate()` materialises a default project for the
        // application shell.  This workspace-scoped contract fixture owns a
        // single project; leaving that seed row would correctly make C2-ZA
        // report the unseeded project's current epoch as missing.
        conn.execute("DELETE FROM projects WHERE id = 'default-project'", [])?;
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

fn consumer_freshness_row(db: &Database, consumer_id: &str) -> ConsumerFreshnessRow {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT project_id, consumer_kind, consumer_key, evidence_freshness,
                    build_action, semantic_epoch_id, last_evaluated_run_id,
                    dependency_set_digest, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, consumer_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                ))
            },
        )?)
    })
    .expect("read complete Generic Consumer Freshness row")
}

fn application_edge_freshness_row(db: &Database, application_id: &str) -> EdgeFreshnessRow {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT s.edge_id, s.evidence_freshness, s.reason_code, s.build_action,
                    s.evaluated_at_epoch_id, s.evaluated_at
               FROM narrative_dependency_edge_states s
               JOIN narrative_dependency_edges e ON e.id = s.edge_id
              WHERE e.project_id = ?1 AND e.consumer_kind = 'application'
                AND e.consumer_key = ?2
              ORDER BY e.source_object_identity, e.id
              LIMIT 1",
            params![PROJECT_ID, application_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )?)
    })
    .expect("read complete Generic Edge State row")
}

fn mutate_scene_source(db: &Database) {
    let result = save_scene_body_bundle(
        db,
        SaveSceneBodyBundlePayload {
            scene_id: "scene-c2zc".to_string(),
            project_id: PROJECT_ID.to_string(),
            request_id: "request-c2zc-source-update".to_string(),
            session_id: "session-c2zc-source-update".to_string(),
            event_uid: "event-c2zc-source-update".to_string(),
            origin: NarrativeChangeOrigin::Human,
            timelapse_steps: None,
            include_sidecars: false,
            base_version: Some(0),
            updated_at: "2026-08-24T00:00:01.000Z".to_string(),
            content_json: r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"source update"}]}]}"#.to_string(),
            char_count: 12,
            placed_beat_preview: None,
            unplaced_beats_doc: "[]".to_string(),
            unplaced_beat_preview: None,
            authorship_spans: vec![],
            foreshadow_setups: vec![],
            foreshadow_payoffs: vec![],
            foreshadow_base_versions: std::collections::HashMap::new(),
            annotation_anchors: vec![],
            beat_mentions: vec![],
            beat_pov_overrides: vec![],
            doc_content_size: 12,
        },
    )
    .expect("mutate exact Source through the typed scene writer");
    assert_eq!(result.content_version, 1);
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

fn temporal_node_payload(node_id: &str) -> Value {
    json!({
        "nodeId": node_id,
        "timelineKind": "primary",
        "subject": {
            "kind": "named-period",
            "label": "C2-ZC idempotent temporal node",
        },
        "shape": "point",
    })
}

fn seed_approved_temporal_node(
    db: &Database,
    run_id: &str,
    task_id: &str,
    set_id: &str,
    proposal_id: &str,
    node_id: &str,
) -> (String, String, String, String) {
    narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: PROJECT_ID.to_string(),
            surface_path_id: "temporal.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "temporal" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: Some(format!("v0@{NOW}")),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "temporal.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create temporal source run");
    // The public CreateRun DTO deliberately leaves the Epoch binding to the
    // caller's live workspace seam.  Bind this test-owned proposal Run to the
    // fixture's current Epoch so the incremental runtime can prove its
    // producer-epoch guard rather than conservatively publishing Unknown.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET semantic_epoch_id = ?1
              WHERE id = ?2 AND project_id = ?3",
            params![EPOCH_ID, run_id, PROJECT_ID],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("bind temporal proposal Run to the fixture Epoch");
    let saved = narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: PROJECT_ID.to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "temporal.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("key-{run_id}"),
                kind: "temporal.node.ensure".to_string(),
                payload_json: temporal_node_payload(node_id),
                reconciliation_envelope: Some(prepared_envelope(run_id, task_id)),
            }],
        },
    )
    .expect("save temporal proposal");
    let saved_proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("saved temporal proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("saved temporal revision id")
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
    .expect("approve temporal proposal");
    (
        run_id.to_string(),
        set_id.to_string(),
        saved_proposal_id,
        revision_id,
    )
}

fn apply_temporal_node(
    db: &Database,
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
    node_id: &str,
    request_id: &str,
) -> Value {
    let prepared = narrative_extraction_prepare_commit(
        db,
        PrepareCommitPayload {
            project_id: PROJECT_ID.to_string(),
            run_id: run_id.to_string(),
            proposal_set_id: set_id.to_string(),
            request_id: request_id.to_string(),
            plan_digest: format!("plan-{run_id}"),
            session_id: format!("session-{run_id}"),
            surface: Some("narrative-extraction".to_string()),
            operations: vec![CommitOperation {
                kind: "temporal.node.ensure".to_string(),
                payload: temporal_node_payload(node_id),
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
        },
    )
    .expect("prepare temporal node commit");
    narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: PROJECT_ID.to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared temporal commit id")
                .to_string(),
            request_id: request_id.to_string(),
            session_id: format!("session-{run_id}"),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply temporal node commit")
}

fn application_id_for_commit(db: &Database, commit: &Value) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_proposal_applications WHERE commit_id = ?1",
            [commit["commitId"].as_str().expect("commit id")],
            |row| row.get(0),
        )?)
    })
    .expect("read temporal Application id")
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

#[test]
fn second_temporal_node_ensure_initializes_generic_without_false_feed() {
    let db = fixture_db();
    db.with_conn(|conn| seed_cutover_ready_application(conn))
        .expect("seed all C2-ZA durable prerequisites");
    let evidence = record_live_scheduler_heartbeat(&db, "c2zc-temporal-authority", 1)
        .expect("mint live scheduler heartbeat from production seam");
    db.with_conn(|conn| cut_over_workspace_freshness(conn, &evidence))
        .expect("activate Generic Consumer Freshness");
    enable_manual_apply(&db);

    let first_parts = seed_approved_temporal_node(
        &db,
        "run-c2zc-temporal-first",
        "task-c2zc-temporal-first",
        "set-c2zc-temporal-first",
        "proposal-c2zc-temporal-first",
        "temporal-node-c2zc",
    );
    let first_commit = apply_temporal_node(
        &db,
        &first_parts.0,
        &first_parts.1,
        &first_parts.2,
        &first_parts.3,
        "temporal-node-c2zc",
        "request-c2zc-temporal-first",
    );
    let first_application_id = application_id_for_commit(&db, &first_commit);
    let first_cycle = run_incremental_freshness_cycle(&db).expect("evaluate first node Feed");
    assert!(matches!(
        first_cycle,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(_)
    ));

    let feed_transactions_before_second = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = ?1",
                [PROJECT_ID],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("count Feed transactions before second ensure");
    let first_row_before_second = consumer_freshness_row(&db, &first_application_id);

    let second_parts = seed_approved_temporal_node(
        &db,
        "run-c2zc-temporal-second",
        "task-c2zc-temporal-second",
        "set-c2zc-temporal-second",
        "proposal-c2zc-temporal-second",
        "temporal-node-c2zc",
    );
    let second_commit = apply_temporal_node(
        &db,
        &second_parts.0,
        &second_parts.1,
        &second_parts.2,
        &second_parts.3,
        "temporal-node-c2zc",
        "request-c2zc-temporal-second",
    );
    let second_application_id = application_id_for_commit(&db, &second_commit);
    assert_ne!(first_application_id, second_application_id);
    assert!(
        second_commit.get("maintenanceTransactionId").is_none(),
        "ensure-existing must not fabricate a Change Feed transaction"
    );

    db.with_conn(|conn| {
        let feed_transactions_after_second: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )?;
        assert_eq!(
            feed_transactions_after_second, feed_transactions_before_second,
            "second ensure must preserve the no-false-Feed contract"
        );
        let edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_dependency_edges
              WHERE project_id = ?1 AND consumer_kind = 'application'
                AND consumer_key = ?2",
            params![PROJECT_ID, second_application_id],
            |row| row.get(0),
        )?;
        assert_eq!(edge_count, 1, "second ensure declares its Generic Edge");
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify second typed Application declaration");

    let second_edge_before_source = application_edge_freshness_row(&db, &second_application_id);
    assert_eq!(second_edge_before_source.1, "unknown");
    assert_eq!(second_edge_before_source.2, None);
    assert_eq!(second_edge_before_source.3, "manual");
    assert_eq!(second_edge_before_source.4, EPOCH_ID);
    let second_consumer_before_source = consumer_freshness_row(&db, &second_application_id);
    assert_eq!(second_consumer_before_source.0, PROJECT_ID);
    assert_eq!(second_consumer_before_source.1, "application");
    assert_eq!(second_consumer_before_source.2, second_application_id);
    assert_eq!(second_consumer_before_source.3, "unknown");
    assert_eq!(second_consumer_before_source.4, "manual");
    assert_eq!(second_consumer_before_source.5, EPOCH_ID);
    assert_eq!(second_consumer_before_source.6, None);
    assert_eq!(
        second_consumer_before_source.7,
        Some(dependency_set_digest(&[SOURCE_IDENTITY]))
    );

    let next_cycle = run_incremental_freshness_cycle(&db).expect("next cycle is restart-safe");
    assert!(matches!(
        next_cycle,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));

    db.with_conn(|conn| {
        let canonical = canonical_application_freshness(conn, PROJECT_ID, &second_application_id)?
            .expect("second ensure Application has canonical Generic Freshness");
        assert_eq!(
            canonical.authority,
            CanonicalFreshnessAuthority::GenericConsumerFreshness
        );
        assert_eq!(canonical.evidence_freshness, "unknown");
        assert_eq!(canonical.build_action, "manual");
        assert_eq!(canonical.semantic_epoch_id, EPOCH_ID);
        assert_eq!(
            canonical.dependency_set_digest,
            Some(dependency_set_digest(&[SOURCE_IDENTITY,]))
        );
        Ok::<_, anyhow::Error>(())
    })
    .expect("read second canonical Generic result without unrelated evaluation");

    assert_eq!(
        consumer_freshness_row(&db, &first_application_id),
        first_row_before_second,
        "idempotent ensure must leave the complete unrelated Consumer row byte-for-byte unchanged"
    );

    mutate_scene_source(&db);
    let source_run_id = match run_incremental_freshness_cycle(&db)
        .expect("process real Source mutation through the Feed runtime")
    {
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Processed(summary) => {
            assert!(summary.affected_edge_count >= 1);
            assert!(summary.affected_consumer_count >= 1);
            summary.run_id
        }
        other => panic!("real Source mutation must be processed, got {other:?}"),
    };

    let second_edge_after_source = application_edge_freshness_row(&db, &second_application_id);
    assert_eq!(second_edge_after_source.0, second_edge_before_source.0);
    assert_eq!(second_edge_after_source.1, "stale");
    assert_eq!(
        second_edge_after_source.2.as_deref(),
        Some("source-revision-changed")
    );
    assert_eq!(second_edge_after_source.3, "rebuild-required");
    assert_eq!(second_edge_after_source.4, EPOCH_ID);

    let second_consumer_after_source = consumer_freshness_row(&db, &second_application_id);
    assert_eq!(second_consumer_after_source.0, PROJECT_ID);
    assert_eq!(second_consumer_after_source.1, "application");
    assert_eq!(second_consumer_after_source.2, second_application_id);
    assert_eq!(second_consumer_after_source.3, "stale");
    assert_eq!(second_consumer_after_source.4, "rebuild-required");
    assert_eq!(second_consumer_after_source.5, EPOCH_ID);
    assert_eq!(
        second_consumer_after_source.6.as_deref(),
        Some(source_run_id.as_str())
    );
    assert_eq!(
        second_consumer_after_source.7,
        Some(dependency_set_digest(&[SOURCE_IDENTITY]))
    );
    assert_ne!(
        second_consumer_after_source.3, second_consumer_before_source.3,
        "normal Feed evaluation must replace the seeded Unknown state"
    );
    db.with_conn(|conn| {
        let run_provenance: (String, String, String, Option<String>) = conn.query_row(
            "SELECT project_id, status, semantic_epoch_id, completed_at
               FROM narrative_extraction_runs WHERE id = ?1",
            [source_run_id.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(run_provenance.0, PROJECT_ID);
        assert_eq!(run_provenance.1, "completed");
        assert_eq!(run_provenance.2, EPOCH_ID);
        assert!(run_provenance.3.is_some());
        Ok::<_, anyhow::Error>(())
    })
    .expect("source Feed run carries completed current-epoch provenance");

    let idle_after_source = run_incremental_freshness_cycle(&db)
        .expect("next cycle after normal source publication is restart-safe");
    assert!(matches!(
        idle_after_source,
        grimodex_db::narrative_extraction::IncrementalFreshnessCycleOutcome::Idle
    ));
}
