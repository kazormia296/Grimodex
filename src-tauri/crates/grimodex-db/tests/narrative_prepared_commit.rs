//! Gate B2-1 — Prepared Commit seal and apply-by-id authority.

use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload,
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
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
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
    (run_id.to_string(), set_id.to_string(), proposal_id, revision_id)
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
        let (status, plan_json, fragment): (String, String, Option<String>) = conn.query_row(
            "SELECT c.status, c.prepared_plan_json, r.plan_fragment_json
               FROM narrative_apply_commits c
               JOIN narrative_proposal_revisions r ON r.id = ?1
              WHERE c.id = ?2",
            rusqlite::params![
                revision_id,
                prepared["preparedCommitId"].as_str().unwrap()
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(status, "prepared");
        assert!(plan_json.contains("chronicle.event.create"));
        assert!(fragment.unwrap().contains("chronicle.event.create"));
        Ok(())
    })
    .unwrap();
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
    let first = narrative_extraction::narrative_extraction_prepare_commit(&db, first_payload.clone())
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
    assert!(err
        .to_string()
        .contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
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
