use grimodex_db::narrative_extraction::{
    self, ensure_test_schema, AppendDecisionPayload, ApplyCommitPayload, ClaimTaskPayload,
    CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    GetCommitStatusPayload, PrepareCommitPayload, ProposalSeed, RunRefPayload,
    SaveProposalSetPayload, UndoCommitPayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};

fn test_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.with_conn(|conn| {
        conn.execute(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'p')",
            [],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
            [],
        )?;
        ensure_test_schema(conn)
    })
    .expect("seed narrative extraction schema");
    db
}

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT INTO projects (id, title) VALUES (?, 'Project')",
        &[Value::String("project-1".to_string())],
        "run",
    )
    .expect("insert project");
    db
}

fn insert_scene(db: &Database, scene_id: &str, version: i64) {
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order, version)
         VALUES (?, 'project-1', 'scene', 'Scene', '{}', 'a0', ?)",
        &[
            Value::String(scene_id.to_string()),
            Value::Number(version.into()),
        ],
        "run",
    )
    .expect("insert scene");
}

fn event_create_payload(event_id: &str, title: &str, scene_id: &str, version: i64) -> Value {
    json!({
        "eventId": event_id,
        "title": title,
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": scene_id,
        "evidenceSceneLinks": [{
            "sceneId": scene_id,
            "expectedSceneVersion": version,
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

fn seed_approved_proposals(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    titles: &[&str],
) -> Vec<(String, String)> {
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

    let proposals: Vec<ProposalSeed> = titles
        .iter()
        .enumerate()
        .map(|(index, title)| ProposalSeed {
            proposal_id: Some(format!("prop-{index}")),
            proposal_key: format!("key-{index}"),
            kind: "chronicle.event.create@1".to_string(),
            payload_json: json!({ "title": title }),
        })
        .collect();

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals,
        },
    )
    .expect("save proposal set");

    let mut pairs = Vec::new();
    for proposal in saved["proposals"].as_array().expect("proposals") {
        let proposal_id = proposal["proposalId"].as_str().unwrap().to_string();
        let revision_id = proposal["revisionId"].as_str().unwrap().to_string();
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
        pairs.push((proposal_id, revision_id));
    }
    pairs
}

fn build_apply_payload(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, Value)>,
) -> ApplyCommitPayload {
    let operations: Vec<CommitOperation> = ops
        .iter()
        .map(|(proposal_id, revision_id, payload)| CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: payload.clone(),
            proposal_id: Some(proposal_id.clone()),
            revision_id: Some(revision_id.clone()),
        })
        .collect();
    let applications: Vec<CommitApplicationRef> = ops
        .iter()
        .map(|(proposal_id, revision_id, _)| CommitApplicationRef {
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    ApplyCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: proposal_set_id.to_string(),
        request_id: request_id.to_string(),
        plan_digest: plan_digest.to_string(),
        session_id: "sess-commit".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

#[test]
fn create_run_and_get_run_persist_projection() {
    let db = test_db();
    let created = narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-1".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-1" }),
            spec_json: json!({ "domain": "chronicle", "version": 1 }),
            spec_digest: "spec-digest-1".to_string(),
            snapshot_digest: Some("snapshot-digest-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: Some(json!({ "mode": "partial" })),
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-plan-1".to_string()),
                task_kind: "plan_windows".to_string(),
                input_json: Some(json!({ "windowCount": 2 })),
                priority: Some(5),
            }],
        },
    )
    .expect("create run");

    assert_eq!(created["runId"], "run-integration-1");
    assert_eq!(created["status"], "running");

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-1".to_string(),
        "project-1".to_string(),
    )
    .expect("get run");

    assert_eq!(loaded["run"]["runId"], "run-integration-1");
    assert_eq!(loaded["run"]["projectId"], "project-1");
    assert_eq!(loaded["run"]["snapshotDigest"], "snapshot-digest-1");
    assert_eq!(loaded["taskCounts"]["queued"], 1);
    assert_eq!(loaded["tasks"][0]["taskKind"], "plan_windows");
}

#[test]
fn claim_task_acquires_queued_task_under_immediate_transaction() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-2".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({ "folderId": "folder-2" }),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-digest-2".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-observe-1".to_string()),
                task_kind: "extract_window".to_string(),
                input_json: Some(json!({ "windowId": "w-1" })),
                priority: None,
            }],
        },
    )
    .expect("create run");

    let claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-integration-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-a".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: None,
        },
    )
    .expect("claim task");

    assert_eq!(claim["claimed"], true);
    assert_eq!(claim["task"]["taskId"], "task-observe-1");
    assert_eq!(claim["task"]["taskKind"], "extract_window");
    assert!(claim["task"]["attemptId"].is_string());

    let second_claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-integration-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-b".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: None,
        },
    )
    .expect("second claim");
    assert_eq!(second_claim["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-2".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after claim");
    assert_eq!(loaded["taskCounts"]["running"], 1);
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-a");
}

#[test]
fn cancel_run_marks_active_tasks_cancelled() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-integration-3".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "spec-digest-3".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-cancel-1".to_string()),
                task_kind: "plan_windows".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let cancelled = narrative_extraction::narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "run-integration-3".to_string(),
            project_id: "project-1".to_string(),
        },
    )
    .expect("cancel run");

    assert_eq!(cancelled["status"], "cancelled");

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-integration-3".to_string(),
        "project-1".to_string(),
    )
    .expect("get cancelled run");
    assert_eq!(loaded["run"]["status"], "cancelled");
    assert_eq!(loaded["taskCounts"]["cancelled"], 1);
}

#[test]
fn apply_commit_creates_three_events_atomically() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 3);
    let pairs = seed_approved_proposals(&db, "run-commit-1", "set-1", &["A", "B", "C"]);

    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            event_create_payload("event-a", "A", "scene-1", 3),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            event_create_payload("event-b", "B", "scene-1", 3),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            event_create_payload("event-c", "C", "scene-1", 3),
        ),
    ];
    let payload =
        build_apply_payload("req-atomic-1", "digest-atomic-1", "set-1", "run-commit-1", ops);

    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        PrepareCommitPayload {
            project_id: payload.project_id.clone(),
            run_id: payload.run_id.clone(),
            proposal_set_id: payload.proposal_set_id.clone(),
            request_id: payload.request_id.clone(),
            plan_digest: payload.plan_digest.clone(),
            session_id: payload.session_id.clone(),
            surface: payload.surface.clone(),
            operations: payload.operations.clone(),
            applications: payload.applications.clone(),
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )
    .expect("prepare");
    assert_eq!(prepared["ok"], true);

    let applied =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload).expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);

    let event_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM events WHERE project_id = 'project-1'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(event_count, 3);

    let link_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM scene_events", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(link_count, 3);

    let status = narrative_extraction::narrative_extraction_get_commit_status(
        &db,
        GetCommitStatusPayload {
            project_id: "project-1".to_string(),
            commit_id: None,
            request_id: Some("req-atomic-1".to_string()),
        },
    )
    .expect("status");
    assert_eq!(status["found"], true);
    assert_eq!(status["status"], "applied");
}

#[test]
fn apply_commit_rolls_back_all_on_failure() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 1);
    let pairs = seed_approved_proposals(&db, "run-commit-2", "set-2", &["A", "B"]);

    // Second op expects wrong scene version → whole commit fails.
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            event_create_payload("event-ok", "A", "scene-1", 1),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            event_create_payload("event-bad", "B", "scene-1", 99),
        ),
    ];
    let payload =
        build_apply_payload("req-fail-1", "digest-fail-1", "set-2", "run-commit-2", ops);
    let err = narrative_extraction::narrative_extraction_apply_commit(&db, payload)
        .expect_err("should fail");
    assert!(err.to_string().contains("NEX_SCENE_VERSION_MISMATCH"));

    let event_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(event_count, 0);

    let commit_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_apply_commits",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(commit_count, 0);
}

#[test]
fn apply_commit_is_idempotent_for_same_request_and_digest() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let pairs = seed_approved_proposals(&db, "run-commit-3", "set-3", &["Only"]);
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        event_create_payload("event-only", "Only", "scene-1", 0),
    )];
    let payload =
        build_apply_payload("req-idem-1", "digest-idem-1", "set-3", "run-commit-3", ops);
    let first =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload.clone()).expect("first");
    let second =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload).expect("replay");
    assert_eq!(first["commitId"], second["commitId"]);
    assert_eq!(second["idempotentReplay"], true);

    let event_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(event_count, 1);
}

#[test]
fn apply_commit_rejects_same_request_with_different_digest() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let pairs = seed_approved_proposals(&db, "run-commit-4", "set-4", &["Only"]);
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        event_create_payload("event-only-2", "Only", "scene-1", 0),
    )];
    let first =
        build_apply_payload("req-conflict-1", "digest-a", "set-4", "run-commit-4", ops.clone());
    narrative_extraction::narrative_extraction_apply_commit(&db, first).expect("first");

    let second = build_apply_payload("req-conflict-1", "digest-b", "set-4", "run-commit-4", ops);
    let err = narrative_extraction::narrative_extraction_apply_commit(&db, second)
        .expect_err("conflict");
    assert!(err.to_string().contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn undo_commit_removes_all_events_and_refuses_edited() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let pairs = seed_approved_proposals(&db, "run-commit-5", "set-5", &["A", "B"]);
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            event_create_payload("event-u1", "A", "scene-1", 0),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            event_create_payload("event-u2", "B", "scene-1", 0),
        ),
    ];
    let payload =
        build_apply_payload("req-undo-1", "digest-undo-1", "set-5", "run-commit-5", ops);
    let applied =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload).expect("apply");
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: None,
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

    let event_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(event_count, 0);

    // Redo then edit one event → undo must refuse.
    narrative_extraction::narrative_extraction_redo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: None,
        },
    )
    .expect("redo");

    db.execute(
        "UPDATE events SET title = 'edited by human', version = version + 1 WHERE id = 'event-u1'",
        &[],
        "run",
    )
    .expect("human edit");

    let refuse = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: None,
        },
    )
    .expect_err("edited refuse");
    assert!(refuse.to_string().contains("NEX_COMMIT_EVENT_EDITED"));

    let remaining: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(remaining, 2);
}
