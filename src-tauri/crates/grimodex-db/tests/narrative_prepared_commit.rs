//! Gate B2-1 — Prepared Commit seal and apply-by-id authority.

use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, CreateTaskSeed, PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput, NARRATIVE_REVIEW_ONLY,
};
use serde_json::{json, Value};

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT INTO projects (id, title) VALUES (?, 'Project')",
        &[Value::String("project-1".to_string())],
        "run",
    )
    .expect("insert project");
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, version)
         VALUES ('scene-1', 'project-1', 'scene', 'Scene', 0)",
        &[],
        "run",
    )
    .expect("insert scene");
    db
}

fn enable_manual_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("set manual-apply");
}

fn event_payload() -> Value {
    json!({
        "eventId": "event-prepared-1",
        "title": "Prepared",
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": "scene-1",
        "evidenceSceneLinks": [{
            "sceneId": "scene-1",
            "expectedSceneVersion": 0,
            "evidenceAnchorIds": []
        }],
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

fn envelope(run_id: &str) -> Value {
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{"inputRef": source_key, "kind": "snapshot-document"}]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": "task-prepared",
        "reconcilerId": "test.prepared",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "chronicle.event",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "snapshot-document",
            "sourceKey": source_key,
            "revisionToken": "revision-1"
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn seed_one_approved(db: &Database) -> (String, String, String, String) {
    let run_id = "run-prepared";
    let set_id = "set-prepared";
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-prepared".to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-prepared".to_string()),
                proposal_key: "key-prepared".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: event_payload(),
                reconciliation_envelope: Some(envelope(run_id)),
            }],
        },
    )
    .expect("save");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .unwrap()
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
    narrative_extraction::narrative_extraction_append_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("test".to_string()),
        },
    )
    .expect("approve");
    (
        run_id.to_string(),
        set_id.to_string(),
        proposal_id,
        revision_id,
    )
}

fn build_prepare(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: "req-prepared-1".to_string(),
        plan_digest: "client-ignored".to_string(),
        session_id: "sess-prepared".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: event_payload(),
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

fn apply_prepared(db: &Database, prepared: &Value) -> anyhow::Result<Value> {
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared commit id")
                .to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
}

#[test]
fn review_only_blocks_prepare() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect_err("review-only");
    assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
}

#[test]
fn prepare_seals_prepared_commit_row() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");
    assert_eq!(prepared["ok"], true);
    assert_eq!(prepared["status"], "prepared");
    assert!(prepared["preparedCommitId"].as_str().unwrap().len() > 8);
    assert!(prepared["planDigest"].as_str().unwrap().len() == 64);
    assert!(prepared["authorityDigest"].as_str().unwrap().len() == 64);

    db.with_conn(|conn| {
        let (status, plan_json): (String, String) = conn.query_row(
            "SELECT c.status, c.prepared_plan_json
               FROM narrative_apply_commits c
              WHERE c.id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(status, "prepared");
        assert!(plan_json.contains("chronicle.event.create"));
        assert!(plan_json.contains("planFragments"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn apply_records_source_contract_and_freshness_only_dependency() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    db.with_conn(|conn| {
        let plan_json: String = conn.query_row(
            "SELECT prepared_plan_json FROM narrative_apply_commits WHERE id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?;
        let plan: Value = serde_json::from_str(&plan_json)?;
        let contract = plan
            .get("sourceContract")
            .and_then(Value::as_object)
            .expect("sealed source contract");
        for field in [
            "revisionEnvelopeDigest",
            "aggregateSourceBasisDigest",
            "aggregateReadSetDigest",
        ] {
            assert!(contract[field].as_str().unwrap().starts_with("sha256:"));
        }
        Ok(())
    })?;

    let applied = apply_prepared(&db, &prepared).expect("apply");
    assert_eq!(applied["status"], "applied");

    db.with_conn(|conn| {
        let application_id: String = conn.query_row(
            "SELECT id
               FROM narrative_proposal_applications
              WHERE commit_id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?;
        let (freshness_status, propagation, observed_token): (String, String, String) = conn
            .query_row(
                "SELECT f.status, d.propagation, d.observed_revision_token
                   FROM narrative_projection_freshness f
                   JOIN narrative_projection_dependencies d
                     ON d.application_id = f.application_id
                  WHERE f.application_id = ?1",
                rusqlite::params![application_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        assert_eq!(freshness_status, "fresh");
        assert_eq!(propagation, "freshness-only");
        assert_eq!(observed_token, "revision-1");
        Ok(())
    })?;
    Ok(())
}

#[test]
fn stale_source_invalidates_prepared_commit_without_domain_mutation() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    db.execute(
        "UPDATE narrative_extraction_runs
            SET snapshot_digest = ?1
          WHERE id = ?2",
        &[
            Value::String("revision-2".to_string()),
            Value::String(run_id),
        ],
        "run",
    )
    .expect("advance snapshot revision");

    let error = apply_prepared(&db, &prepared).expect_err("stale source must reject apply");
    assert!(error.to_string().contains("NEX_SOURCE_BASIS_STALE"));

    db.with_conn(|conn| {
        let (status, application_count, operation_count, journal_count, change_event_count): (
            String,
            i64,
            i64,
            i64,
            i64,
        ) = conn.query_row(
            "SELECT c.status,
                    (SELECT COUNT(*) FROM narrative_proposal_applications WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_apply_operations WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_commit_journals WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM change_events
                      WHERE project_id = c.project_id AND entity_id = c.id)
               FROM narrative_apply_commits c
              WHERE c.id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        assert_eq!(status, "invalidated");
        assert_eq!(application_count, 0);
        assert_eq!(operation_count, 0);
        assert_eq!(journal_count, 0);
        assert_eq!(change_event_count, 0);
        let event_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM events WHERE id = 'event-prepared-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(event_count, 0);
        Ok(())
    })?;
    Ok(())
}

#[test]
fn legacy_unbound_revision_fails_closed_at_prepare() {
    let db = migrated_db();
    let run_id = "run-legacy-prepare";
    let set_id = "set-legacy-prepare";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "legacy-spec".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create legacy run");
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-legacy-prepare".to_string()),
                proposal_key: "key-legacy-prepare".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: event_payload(),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save legacy proposal");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();
    narrative_extraction::narrative_extraction_append_decision(
        &db,
        grimodex_db::narrative_extraction::AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("approve legacy proposal for review-only proof");
    enable_manual_apply(&db);
    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(run_id, set_id, &proposal_id, &revision_id),
    )
    .expect_err("legacy revision must not reach Apply");
    assert!(error.to_string().contains("NEX_REVISION_LEGACY_UNBOUND"));
}

#[test]
fn apply_requires_prepared_commit_id_and_matching_session() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    let missing = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: "missing".to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: None,
        },
    )
    .expect_err("missing");
    assert!(missing.to_string().contains("prepared commit not found"));

    let session_mismatch = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "wrong-session".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect_err("session");
    assert!(session_mismatch
        .to_string()
        .contains("NEX_COMMIT_SESSION_MISMATCH"));

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"][0]["entityId"], "event-prepared-1");
}

#[test]
fn prepare_is_idempotent_for_same_request_and_native_digest() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);

    let first_payload = build_prepare(&run_id, &set_id, &proposal_id, &revision_id);
    let first =
        narrative_extraction::narrative_extraction_prepare_commit(&db, first_payload.clone())
            .expect("first prepare");
    let second = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        PrepareCommitPayload {
            plan_digest: "different-client-digest".to_string(),
            ..first_payload
        },
    )
    .expect("same native plan must replay");

    assert_eq!(second["preparedCommitId"], first["preparedCommitId"]);
    assert_eq!(second["planDigest"], first["planDigest"]);
    assert_eq!(second["idempotentReplay"], true);
}

#[test]
fn prepare_rejects_same_request_with_different_native_plan() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);

    let first_payload = build_prepare(&run_id, &set_id, &proposal_id, &revision_id);
    narrative_extraction::narrative_extraction_prepare_commit(&db, first_payload.clone())
        .expect("first prepare");
    let mut changed_payload = first_payload;
    changed_payload.operations[0].payload["title"] = json!("forged");

    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, changed_payload)
        .expect_err("native plan change must conflict");
    assert!(err.to_string().contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn apply_version_cas_rejects_stale_version_without_poisoning_prepared_commit() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");
    let prepared_commit_id = prepared["preparedCommitId"].as_str().unwrap().to_string();

    let stale = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared_commit_id.clone(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: Some(99),
        },
    )
    .expect_err("stale version");
    assert!(stale.to_string().contains("NEX_COMMIT_VERSION_MISMATCH"));

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id,
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("retry after stale version");
    assert_eq!(applied["status"], "applied");
}
