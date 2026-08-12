use chrono::{Duration, Utc};
use grimodex_db::narrative_extraction::{
    self, ensure_test_schema, AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload,
    ClaimTaskPayload, CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    FinishTaskPayload, GetCommitStatusPayload, ListResumableRunsPayload, PrepareCommitPayload,
    ProposalSeed, ReviseAndDecidePayload, RunRefPayload, SaveProposalSetPayload, UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy,
    SetNarrativeRuntimePolicyInput, Database,
};
use serde_json::{json, Value};

fn rfc3339_millis(dt: chrono::DateTime<Utc>) -> String {
    dt.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn create_run_with_task(db: &Database, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "extract_window".to_string(),
                input_json: Some(json!({ "windowId": "w-1" })),
                priority: None,
            }],
        },
    )
    .expect("create run");
}

fn claim_with_owner(db: &Database, run_id: &str, lease_owner: &str, lease_secs: i64) -> Value {
    narrative_extraction::narrative_extraction_claim_task(
        db,
        ClaimTaskPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            lease_owner: lease_owner.to_string(),
            lease_duration_secs: Some(lease_secs),
            task_kinds: None,
        },
    )
    .expect("claim task")
}

fn set_task_lease_expires_at(db: &Database, task_id: &str, lease_expires_at: &str) {
    db.execute(
        "UPDATE narrative_extraction_tasks
            SET lease_expires_at = ?
          WHERE id = ?",
        &[
            Value::String(lease_expires_at.to_string()),
            Value::String(task_id.to_string()),
        ],
        "run",
    )
    .expect("set lease_expires_at");
}

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
    payloads: &[Value],
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

    let proposals: Vec<ProposalSeed> = payloads
        .iter()
        .enumerate()
        .map(|(index, payload)| ProposalSeed {
            proposal_id: Some(format!("{run_id}-prop-{index}")),
            proposal_key: format!("{run_id}-key-{index}"),
            kind: "chronicle.event.create@1".to_string(),
            payload_json: payload.clone(),
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

fn prepare_and_apply(db: &Database, prepare: PrepareCommitPayload) -> Value {
    enable_manual_apply(db);
    let prepared =
        narrative_extraction::narrative_extraction_prepare_commit(db, prepare.clone())
            .expect("prepare");
    let prepared_commit_id = prepared["preparedCommitId"]
        .as_str()
        .expect("id")
        .to_string();
    let version = prepared["version"].as_i64();
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id,
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: version,
        },
    )
    .expect("apply")
}

fn build_prepare(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, Value)>,
) -> PrepareCommitPayload {
    let operations: Vec<CommitOperation> = ops
        .iter()
        .map(|(proposal_id, revision_id, payload)| CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: payload.clone(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    let applications: Vec<CommitApplicationRef> = ops
        .iter()
        .map(|(proposal_id, revision_id, _)| CommitApplicationRef {
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    PrepareCommitPayload {
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
fn claim_task_reclaims_same_day_expired_rfc3339_lease() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-expired", "task-lease-expired");

    let first = claim_with_owner(&db, "run-lease-expired", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-expired", &past);

    let reclaim = claim_with_owner(&db, "run-lease-expired", "worker-b", 120);
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-lease-expired");
    assert_eq!(reclaim["task"]["attemptNumber"], 2);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-expired".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after reclaim");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-b");
}

#[test]
fn claim_task_does_not_reclaim_same_day_future_rfc3339_lease() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-future", "task-lease-future");

    let first = claim_with_owner(&db, "run-lease-future", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    let future = rfc3339_millis(Utc::now() + Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-future", &future);

    let second = claim_with_owner(&db, "run-lease-future", "worker-b", 120);
    assert_eq!(second["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-future".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after blocked reclaim");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-a");
}

#[test]
fn claim_task_reclaims_lease_across_utc_date_boundary() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-boundary", "task-lease-boundary");

    let first = claim_with_owner(&db, "run-lease-boundary", "worker-a", 120);
    assert_eq!(first["claimed"], true);

    // Yesterday late UTC still expires before "now", even when calendar day differs.
    let past_across_day = rfc3339_millis(Utc::now() - Duration::hours(25));
    set_task_lease_expires_at(&db, "task-lease-boundary", &past_across_day);

    let reclaim = claim_with_owner(&db, "run-lease-boundary", "worker-b", 120);
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-lease-boundary");

    // Tomorrow early UTC must remain leased.
    let future_across_day = rfc3339_millis(Utc::now() + Duration::hours(25));
    set_task_lease_expires_at(&db, "task-lease-boundary", &future_across_day);

    let blocked = claim_with_owner(&db, "run-lease-boundary", "worker-c", 120);
    assert_eq!(blocked["claimed"], false);

    let loaded = narrative_extraction::narrative_extraction_get_run(
        &db,
        "run-lease-boundary".to_string(),
        "project-1".to_string(),
    )
    .expect("get run after boundary checks");
    assert_eq!(loaded["tasks"][0]["leaseOwner"], "worker-b");
}

#[test]
fn claim_task_with_single_kind_filter_binds_parameters() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-kind-1".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-kind-1".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![
                CreateTaskSeed {
                    task_id: Some("task-snapshot".to_string()),
                    task_kind: "snapshot".to_string(),
                    input_json: Some(json!({ "stage": 1 })),
                    priority: Some(3),
                },
                CreateTaskSeed {
                    task_id: Some("task-observe".to_string()),
                    task_kind: "observe".to_string(),
                    input_json: Some(json!({ "stage": 2 })),
                    priority: Some(2),
                },
            ],
        },
    )
    .expect("create run");

    let claim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-1".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-kind".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string()]),
        },
    )
    .expect("claim snapshot by kind");
    assert_eq!(claim["claimed"], true);
    assert_eq!(claim["task"]["taskId"], "task-snapshot");
    assert_eq!(claim["task"]["taskKind"], "snapshot");
}

#[test]
fn claim_task_with_multi_kind_filter_and_miss_and_expired_lease() {
    let db = test_db();
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-kind-2".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-kind-2".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![
                CreateTaskSeed {
                    task_id: Some("task-snapshot-2".to_string()),
                    task_kind: "snapshot".to_string(),
                    input_json: Some(json!({ "stage": 1 })),
                    priority: Some(3),
                },
                CreateTaskSeed {
                    task_id: Some("task-observe-2".to_string()),
                    task_kind: "observe".to_string(),
                    input_json: Some(json!({ "stage": 2 })),
                    priority: Some(2),
                },
            ],
        },
    )
    .expect("create run");

    let miss = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-miss".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["synthesize".to_string()]),
        },
    )
    .expect("kind miss must not error");
    assert_eq!(miss["claimed"], false);

    let first = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-a".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string(), "observe".to_string()]),
        },
    )
    .expect("multi-kind claim");
    assert_eq!(first["claimed"], true);
    assert_eq!(first["task"]["taskId"], "task-snapshot-2");

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-snapshot-2", &past);

    let reclaim = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-kind-2".to_string(),
            project_id: "project-1".to_string(),
            lease_owner: "worker-b".to_string(),
            lease_duration_secs: Some(120),
            task_kinds: Some(vec!["snapshot".to_string()]),
        },
    )
    .expect("expired lease reclaim with kind");
    assert_eq!(reclaim["claimed"], true);
    assert_eq!(reclaim["task"]["taskId"], "task-snapshot-2");
    assert_eq!(reclaim["task"]["attemptNumber"], 2);
}

#[test]
fn finish_task_rejects_after_lease_expiry() {
    let db = test_db();
    create_run_with_task(&db, "run-lease-finish", "task-lease-finish");

    let claim = claim_with_owner(&db, "run-lease-finish", "worker-a", 120);
    assert_eq!(claim["claimed"], true);
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("attemptId")
        .to_string();

    let past = rfc3339_millis(Utc::now() - Duration::minutes(5));
    set_task_lease_expires_at(&db, "task-lease-finish", &past);

    let err = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-lease-finish".to_string(),
            project_id: "project-1".to_string(),
            task_id: "task-lease-finish".to_string(),
            attempt_id,
            lease_owner: "worker-a".to_string(),
            output_json: Some(json!({ "ok": true })),
            artifacts: vec![],
        },
    )
    .expect_err("finish must reject expired lease");
    assert!(
        err.to_string().contains("task lease expired"),
        "unexpected error: {err}"
    );
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
    let payloads = [
        event_create_payload("event-a", "A", "scene-1", 3),
        event_create_payload("event-b", "B", "scene-1", 3),
        event_create_payload("event-c", "C", "scene-1", 3),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-1", "set-1", &payloads);
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            payloads[0].clone(),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            payloads[1].clone(),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            payloads[2].clone(),
        ),
    ];
    let payload =
        build_prepare("req-atomic-1", "digest-atomic-1", "set-1", "run-commit-1", ops);

    let applied = prepare_and_apply(&db, payload);
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
    let payloads = [
        event_create_payload("event-ok", "A", "scene-1", 1),
        event_create_payload("event-bad", "B", "scene-1", 99),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-2", "set-2", &payloads);
    // Second op expects wrong scene version → whole commit fails.
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            payloads[0].clone(),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            payloads[1].clone(),
        ),
    ];
    let payload =
        build_prepare("req-fail-1", "digest-fail-1", "set-2", "run-commit-2", ops);
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("prepare should fail");
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
                "SELECT COUNT(*) FROM narrative_apply_commits WHERE status = 'failed'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(
        commit_count, 0,
        "failed prepare must not create an apply audit row"
    );
}

#[test]
fn apply_commit_is_idempotent_for_same_request_and_digest() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [event_create_payload("event-only", "Only", "scene-1", 0)];
    let pairs = seed_approved_proposals(&db, "run-commit-3", "set-3", &payloads);
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        payloads[0].clone(),
    )];
    let payload =
        build_prepare("req-idem-1", "digest-idem-1", "set-3", "run-commit-3", ops);
    let first = prepare_and_apply(&db, payload.clone());
    let second = prepare_and_apply(&db, payload);
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
    let first_payloads = [event_create_payload("event-only-2", "Only", "scene-1", 0)];
    let first_pairs =
        seed_approved_proposals(&db, "run-commit-4a", "set-4a", &first_payloads);
    let first_ops = vec![(
        first_pairs[0].0.clone(),
        first_pairs[0].1.clone(),
        first_payloads[0].clone(),
    )];
    prepare_and_apply(
        &db,
        build_prepare(
            "req-conflict-1",
            "digest-a",
            "set-4a",
            "run-commit-4a",
            first_ops,
        ),
    );

    // Same requestId but a different sealed plan must conflict on Native digest.
    let second_payloads = [event_create_payload("event-only-3", "Other", "scene-1", 0)];
    let second_pairs =
        seed_approved_proposals(&db, "run-commit-4b", "set-4b", &second_payloads);
    let second_ops = vec![(
        second_pairs[0].0.clone(),
        second_pairs[0].1.clone(),
        second_payloads[0].clone(),
    )];
    let second = build_prepare(
        "req-conflict-1",
        "digest-b",
        "set-4b",
        "run-commit-4b",
        second_ops,
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, second)
        .expect_err("conflict");
    assert!(err.to_string().contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn undo_commit_removes_all_events_and_refuses_edited() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-u1", "A", "scene-1", 0),
        event_create_payload("event-u2", "B", "scene-1", 0),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-5", "set-5", &payloads);
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            payloads[0].clone(),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            payloads[1].clone(),
        ),
    ];
    let payload =
        build_prepare("req-undo-1", "digest-undo-1", "set-5", "run-commit-5", ops);
    let applied = prepare_and_apply(&db, payload);
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

#[test]
fn undo_redo_cycles_without_event_edited_false_positive() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [
        event_create_payload("event-cycle-1", "A", "scene-1", 0),
        event_create_payload("event-cycle-2", "B", "scene-1", 0),
    ];
    let pairs = seed_approved_proposals(&db, "run-commit-6", "set-6", &payloads);
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            payloads[0].clone(),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            payloads[1].clone(),
        ),
    ];
    let payload =
        build_prepare("req-cycle-1", "digest-cycle-1", "set-6", "run-commit-6", ops);
    let applied = prepare_and_apply(&db, payload);
    let commit_id = applied["commitId"].as_str().unwrap().to_string();
    let undo_payload = UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess".to_string(),
        surface: None,
        commit_id: Some(commit_id),
        request_id: None,
    };

    for cycle in 1..=2 {
        let undone = narrative_extraction::narrative_extraction_undo_commit(
            &db,
            undo_payload.clone(),
        )
        .unwrap_or_else(|err| panic!("undo cycle {cycle}: {err}"));
        assert_eq!(undone["status"], "undone");

        let event_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(event_count, 0, "events must be gone after undo cycle {cycle}");

        let redone = narrative_extraction::narrative_extraction_redo_commit(
            &db,
            undo_payload.clone(),
        )
        .unwrap_or_else(|err| panic!("redo cycle {cycle}: {err}"));
        assert_eq!(redone["status"], "redone");

        let event_count: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(event_count, 2, "events must be restored after redo cycle {cycle}");

        let versions: Vec<i64> = db
            .with_conn(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT version FROM events
                      WHERE id IN ('event-cycle-1', 'event-cycle-2')
                      ORDER BY id",
                )?;
                let rows = stmt.query_map([], |row| row.get(0))?;
                rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
            })
            .unwrap();
        // Apply starts at 1; each redo bumps to previous+1.
        assert_eq!(versions, vec![cycle + 1, cycle + 1]);
    }

    // Final undo after two full cycles must still succeed (journal stayed in sync).
    let final_undo =
        narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload).expect("final undo");
    assert_eq!(final_undo["status"], "undone");
}

#[test]
fn append_decision_rejects_stale_revision_when_current_advanced() {
    let db = migrated_db();
    let run_id = "run-occ-1";
    let proposal_set_id = "set-occ-1";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-occ".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-occ".to_string()),
                proposal_key: "key-occ".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Rev1" }),
            }],
        },
    )
    .expect("save");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .unwrap()
        .to_string();
    let rev1 = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();

    let rev2 = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            created_by: Some("test".to_string()),
        },
    )
    .expect("append rev2");
    let rev2_id = rev2["revisionId"].as_str().unwrap().to_string();
    assert_ne!(rev1, rev2_id);

    let stale = narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: rev1,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("stale-window".to_string()),
        },
    )
    .expect_err("stale revision must fail");
    assert!(
        stale
            .to_string()
            .contains("NEX_PROPOSAL_REVISION_MISMATCH"),
        "unexpected error: {stale}"
    );

    let status: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");

    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id,
            revision_id: rev2_id,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("current-window".to_string()),
        },
    )
    .expect("current revision approve");
}

/// Create a run + a single-proposal ProposalSet, returning (proposalId, rev1).
fn seed_single_proposal(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    proposal_id: &str,
) -> (String, String) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
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
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("{proposal_id}-key"),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Rev1" }),
            }],
        },
    )
    .expect("save proposal set");

    let rev1 = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
    (proposal_id.to_string(), rev1)
}

fn count_revisions(db: &Database, proposal_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_proposal_revisions WHERE proposal_id = ?1",
            rusqlite::params![proposal_id],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn revise_and_decide_approves_atomically_with_new_revision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-happy", "set-rad-happy", "prop-rad-happy");
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let result = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-happy".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({ "source": "test" })),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("revise and decide");

    let new_revision_id = result["revisionId"].as_str().unwrap().to_string();
    assert_ne!(new_revision_id, rev1);
    assert_eq!(result["revisionNumber"], 2);
    assert_eq!(result["decision"], "approved");
    assert_eq!(result["status"], "approved");
    assert_eq!(result["proposalId"], proposal_id);
    assert!(result["decisionId"].is_string());

    // Both writes landed atomically.
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "approved");
    assert_eq!(current_revision, new_revision_id);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions
                  WHERE proposal_id = ?1 AND revision_id = ?2 AND decision = 'approved'",
                rusqlite::params![proposal_id, new_revision_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 1);
}

#[test]
fn revise_and_decide_rolls_back_revision_on_invalid_decision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-bad", "set-rad-bad", "prop-rad-bad");
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let err = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-bad".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            decision: "totally-bogus".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect_err("invalid decision must fail");
    assert!(
        err.to_string().contains("unsupported proposal decision"),
        "unexpected error: {err}"
    );

    // The would-be revision must be rolled back with the failed decision.
    assert_eq!(count_revisions(&db, &proposal_id), 1);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");
    assert_eq!(current_revision, rev1);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 0);
}

#[test]
fn revise_and_decide_rejects_stale_expected_current_revision() {
    let db = migrated_db();
    let (proposal_id, rev1) =
        seed_single_proposal(&db, "run-rad-stale", "set-rad-stale", "prop-rad-stale");

    // Advance the current revision so rev1 becomes stale.
    let rev2 = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-rad-stale".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev2" }),
            expected_current_revision_id: rev1.clone(),
            created_by: Some("test".to_string()),
        },
    )
    .expect("append rev2");
    let rev2_id = rev2["revisionId"].as_str().unwrap().to_string();
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let err = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-rad-stale".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: json!({ "title": "Rev3" }),
            expected_current_revision_id: rev1.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("stale-window".to_string()),
        },
    )
    .expect_err("stale expected revision must conflict");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_REVISION_CONFLICT"),
        "unexpected error: {err}"
    );

    // No third revision, no decision, current stays at rev2, status unreviewed.
    assert_eq!(count_revisions(&db, &proposal_id), 2);

    let (status, current_revision): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, current_revision_id FROM narrative_proposals WHERE id = ?1",
                rusqlite::params![proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    assert_eq!(status, "unreviewed");
    assert_eq!(current_revision, rev2_id);

    let decision_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE proposal_id = ?1",
                rusqlite::params![proposal_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(decision_count, 0);
}

#[test]
fn get_run_review_bundle_returns_artifacts_proposals_and_latest_decision() {
    let db = test_db();
    create_run_with_task(&db, "run-review-bundle", "task-review-bundle");

    let claim = claim_with_owner(&db, "run-review-bundle", "worker-bundle", 120);
    assert_eq!(claim["claimed"], true);
    let attempt_id = claim["task"]["attemptId"]
        .as_str()
        .expect("attemptId")
        .to_string();

    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            task_id: "task-review-bundle".to_string(),
            attempt_id,
            lease_owner: "worker-bundle".to_string(),
            output_json: Some(json!({ "ok": true })),
            artifacts: vec![
                narrative_extraction::ArtifactInput {
                    artifact_id: Some("art-proposals".to_string()),
                    artifact_kind: "chronicle.extract.proposals@1".to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({
                        "proposalSetId": "set-review-bundle",
                        "proposals": [{ "eventId": "ev-1", "title": "From artifact" }],
                        "planned": [{
                            "proposal": { "eventId": "ev-1", "title": "From artifact" },
                            "match": { "status": "none" },
                            "hypothesisId": "h-1"
                        }]
                    })),
                    payload_ref: None,
                    payload_digest: None,
                },
                narrative_extraction::ArtifactInput {
                    artifact_id: Some("art-snapshot".to_string()),
                    artifact_kind: "chronicle.extract.snapshot@1".to_string(),
                    payload_storage: Some("inline-json".to_string()),
                    payload_json: Some(json!({ "snapshot": { "documents": [] } })),
                    payload_ref: None,
                    payload_digest: None,
                },
            ],
        },
    )
    .expect("finish with artifacts");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-review-bundle".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-review-1".to_string()),
                proposal_key: "ev-1:0".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "eventId": "ev-1", "title": "Native title" }),
            }],
        },
    )
    .expect("save proposal set");
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revisionId")
        .to_string();

    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: "prop-review-1".to_string(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({ "source": "test" })),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("approve");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "project-1".to_string(),
        },
    )
    .expect("get review bundle");

    assert_eq!(bundle["runId"], "run-review-bundle");
    assert_eq!(bundle["projectId"], "project-1");
    let artifacts = bundle["artifacts"].as_array().expect("artifacts");
    assert_eq!(artifacts.len(), 2);
    assert!(artifacts.iter().any(|a| {
        a["artifactKind"] == "chronicle.extract.proposals@1"
            && a["payloadJson"]["proposalSetId"] == "set-review-bundle"
    }));

    assert_eq!(
        bundle["proposalSet"]["proposalSetId"],
        "set-review-bundle"
    );
    let proposals = bundle["proposals"].as_array().expect("proposals");
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0]["proposalId"], "prop-review-1");
    assert_eq!(proposals[0]["proposalKey"], "ev-1:0");
    assert_eq!(proposals[0]["status"], "approved");
    assert_eq!(proposals[0]["currentRevisionId"], revision_id);
    assert_eq!(proposals[0]["payloadJson"]["title"], "Native title");
    assert_eq!(proposals[0]["latestDecision"]["decision"], "approved");
    assert_eq!(proposals[0]["latestDecision"]["revisionId"], revision_id);
    assert_eq!(
        proposals[0]["latestDecision"]["decisionJson"]["source"],
        "test"
    );

    let mismatch = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-review-bundle".to_string(),
            project_id: "other-project".to_string(),
        },
    )
    .expect_err("project mismatch must fail closed");
    assert!(
        mismatch
            .to_string()
            .contains("narrative extraction run project mismatch"),
        "unexpected error: {mismatch}"
    );
}

#[test]
fn apply_commit_rejects_missing_applications_and_unapproved_payload() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let payloads = [event_create_payload("event-x", "X", "scene-1", 0)];
    let pairs = seed_approved_proposals(&db, "run-failopen", "set-failopen", &payloads);

    let payload = build_prepare(
        "req-failopen-1",
        "digest-failopen-1",
        "set-failopen",
        "run-failopen",
        vec![(
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            payloads[0].clone(),
        )],
    );
    let mut payload = payload;
    payload.applications.clear();
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("empty applications must fail closed");
    assert!(
        err.to_string()
            .contains("NEX_COMMIT_APPLICATIONS_MISMATCH"),
        "unexpected error: {err}"
    );

    // Unapproved proposal must not apply even with matching applications.
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-unapproved".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-unapproved".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create");
    let unapproved_payload = event_create_payload("event-unapproved", "Nope", "scene-1", 0);
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unapproved".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unapproved".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-unapproved".to_string()),
                proposal_key: "key-unapproved".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: unapproved_payload.clone(),
            }],
        },
    )
    .expect("save");
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
    let payload = build_prepare(
        "req-unapproved",
        "digest-unapproved",
        "set-unapproved",
        "run-unapproved",
        vec![(
            "prop-unapproved".to_string(),
            revision_id,
            unapproved_payload,
        )],
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("unapproved must fail");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_NOT_APPROVED"),
        "unexpected error: {err}"
    );
}

#[test]
fn apply_commit_rejects_revision_payload_mismatch() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    let approved = [event_create_payload("event-m", "M", "scene-1", 0)];
    let pairs =
        seed_approved_proposals(&db, "run-rev-mismatch", "set-rev-mismatch", &approved);
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        // Title diverges from approved revision → digest mismatch.
        event_create_payload("event-m", "Different", "scene-1", 0),
    )];
    let payload = build_prepare(
        "req-rev-mismatch",
        "digest-rev-mismatch",
        "set-rev-mismatch",
        "run-rev-mismatch",
        ops,
    );
    enable_manual_apply(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, payload)
        .expect_err("title mismatch must fail");
    assert!(
        err.to_string()
            .contains("NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        "unexpected error: {err}"
    );
}

#[test]
fn list_resumable_runs_excludes_applied_completed_runs() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    // In-progress run without a ProposalSet is NOT review-resumable.
    create_run_with_task(&db, "run-resumable-pending", "task-resumable-pending");
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'running' WHERE id = ?",
        &[Value::String("run-resumable-pending".to_string())],
        "run",
    )
    .expect("mark running");

    // Completed + approved but unapplied → resumable.
    let review_payloads = [event_create_payload("event-r", "R", "scene-1", 0)];
    let pairs = seed_approved_proposals(
        &db,
        "run-resumable-review",
        "set-resumable-review",
        &review_payloads,
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-resumable-review".to_string())],
        "run",
    )
    .expect("mark completed");

    // Completed + applied → not resumable.
    let applied_payloads = [event_create_payload("event-applied", "Applied", "scene-1", 0)];
    let applied_pairs = seed_approved_proposals(
        &db,
        "run-applied",
        "set-applied",
        &applied_payloads,
    );
    let payload = build_prepare(
        "req-applied",
        "digest-applied",
        "set-applied",
        "run-applied",
        vec![(
            applied_pairs[0].0.clone(),
            applied_pairs[0].1.clone(),
            applied_payloads[0].clone(),
        )],
    );
    prepare_and_apply(&db, payload);
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-applied".to_string())],
        "run",
    )
    .expect("mark applied completed");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();
    assert!(
        !ids.contains(&"run-resumable-pending"),
        "running without ProposalSet must not hide review restores"
    );
    assert!(ids.contains(&"run-resumable-review"));
    assert!(!ids.contains(&"run-applied"));
    // pairs used to keep approved revision alive for review run
    assert!(!pairs.is_empty());
}

#[test]
fn list_resumable_runs_prefers_older_review_over_crashed_running() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    // Older completed review with unapplied proposals.
    let review_payloads = [event_create_payload("event-old", "Old", "scene-1", 0)];
    let _pairs = seed_approved_proposals(
        &db,
        "run-old-review",
        "set-old-review",
        &review_payloads,
    );
    db.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'completed',
                started_at = '2026-01-01T00:00:00.000Z',
                completed_at = '2026-01-01T00:01:00.000Z'
          WHERE id = ?",
        &[Value::String("run-old-review".to_string())],
        "run",
    )
    .expect("mark old completed");

    // Newer crashed running run without ProposalSet.
    create_run_with_task(&db, "run-crash-running", "task-crash-running");
    db.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'running',
                started_at = '2026-01-02T00:00:00.000Z'
          WHERE id = ?",
        &[Value::String("run-crash-running".to_string())],
        "run",
    )
    .expect("mark crash running");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec!["run-old-review"]);
}

#[test]
fn relation_dependencies_in_summary_json_survive_append_revision() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);
    create_run_with_task(&db, "run-rel-deps", "task-rel-deps");

    let entity_a = "prop-entity-a";
    let entity_b = "prop-entity-b";
    let relation_id = "prop-relation-1";
    let summary = json!({
        "relationDependencies": {
            relation_id: [
                { "kind": "requires-resolution", "proposalId": entity_a },
                { "kind": "requires-resolution", "proposalId": entity_b }
            ]
        }
    });

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-rel-deps".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(summary.clone()),
            proposals: vec![
                ProposalSeed {
                    proposal_id: Some(entity_a.to_string()),
                    proposal_key: "entity-a".to_string(),
                    kind: "codex.entity.bind@1".to_string(),
                    payload_json: json!({ "narrativeEntityId": "ne-a", "canonicalName": "ライカ" }),
                },
                ProposalSeed {
                    proposal_id: Some(entity_b.to_string()),
                    proposal_key: "entity-b".to_string(),
                    kind: "codex.entity.bind@1".to_string(),
                    payload_json: json!({ "narrativeEntityId": "ne-b", "canonicalName": "ベルカ" }),
                },
                ProposalSeed {
                    proposal_id: Some(relation_id.to_string()),
                    proposal_key: "relation-1".to_string(),
                    kind: "codex.relation.create@1".to_string(),
                    payload_json: json!({
                        "subjectEntityId": "ne-a",
                        "objectEntityId": "ne-b",
                        "relation": {
                            "relationType": "friend",
                            "directionality": "symmetric",
                            "forwardLabel": "友人",
                            "inverseLabel": "友人"
                        },
                        "validity": "current"
                    }),
                },
            ],
        },
    )
    .expect("save");

    let proposals = saved["proposals"].as_array().expect("proposals");
    assert_eq!(proposals.len(), 3);
    for proposal in proposals {
        let id = proposal["proposalId"].as_str().unwrap();
        assert!(
            id == entity_a || id == entity_b || id == relation_id,
            "stable client proposalId must be preserved, got {id}"
        );
    }

    let relation = proposals
        .iter()
        .find(|row| row["proposalId"] == relation_id)
        .expect("relation");
    let revision_id = relation["revisionId"].as_str().unwrap().to_string();

    // Approve-style revision overwrites domain payload without dependencies.
    narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: relation_id.to_string(),
            expected_current_revision_id: revision_id,
            payload_json: json!({
                "kind": "codex.relation.create",
                "fromCodexId": "codex-a",
                "toCodexId": "codex-b",
                "relationType": "friend",
                "forwardLabel": "友人",
                "inverseLabel": "友人",
                "directionality": "symmetric",
                "semanticKey": "friend:a:b"
            }),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("append revision");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-rel-deps".to_string(),
            project_id: "project-1".to_string(),
        },
    )
    .expect("bundle");

    let summary_json = &bundle["proposalSet"]["summaryJson"];
    assert_eq!(
        summary_json["relationDependencies"][relation_id][0]["proposalId"],
        entity_a
    );
    assert_eq!(
        summary_json["relationDependencies"][relation_id][1]["proposalId"],
        entity_b
    );

    let relation_row = bundle["proposals"]
        .as_array()
        .expect("proposals")
        .iter()
        .find(|row| row["proposalId"] == relation_id)
        .expect("relation row");
    assert!(
        relation_row["payloadJson"]
            .get("dependencies")
            .is_none(),
        "domain payload must not carry dependencies after approve revision"
    );
}

#[test]
fn client_proposal_ids_collide_across_runs_when_reused() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    create_run_with_task(&db, "run-collide-1", "task-collide-1");
    narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-collide-1".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-collide-1".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("codex-bind-1".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
            }],
        },
    )
    .expect("first save should succeed");

    create_run_with_task(&db, "run-collide-2", "task-collide-2");
    let err = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-collide-2".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-collide-2".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("codex-bind-1".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
            }],
        },
    )
    .expect_err("reused client proposalId across runs must violate PRIMARY KEY");
    let message = format!("{err:#}");
    assert!(
        message.contains("UNIQUE")
            || message.contains("unique")
            || message.contains("constraint")
            || message.contains("PRIMARY"),
        "unexpected error: {message}"
    );
}

#[test]
fn distinct_client_proposal_ids_persist_across_consecutive_runs() {
    let db = migrated_db();
    insert_scene(&db, "scene-1", 0);

    create_run_with_task(&db, "run-unique-1", "task-unique-1");
    let first = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unique-1".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unique-1".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("11111111-1111-4111-8111-111111111111".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
            }],
        },
    )
    .expect("first unique save");

    create_run_with_task(&db, "run-unique-2", "task-unique-2");
    let second = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-unique-2".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-unique-2".to_string()),
            set_kind: "codex.structure.extract.review@1".to_string(),
            summary_json: Some(json!({ "proposalCount": 1 })),
            proposals: vec![ProposalSeed {
                proposal_id: Some("22222222-2222-4222-8222-222222222222".to_string()),
                proposal_key: "entity-1".to_string(),
                kind: "codex.entity.bind@1".to_string(),
                payload_json: json!({ "canonicalName": "ライカ" }),
            }],
        },
    )
    .expect("second unique save");

    assert_eq!(
        first["proposals"][0]["proposalId"],
        "11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(
        second["proposals"][0]["proposalId"],
        "22222222-2222-4222-8222-222222222222"
    );
}

fn seed_deferred_proposal_with_decision(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    proposal_id: &str,
    decision_json: Value,
) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec-{run_id}"),
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
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("{proposal_id}-key"),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Deferred proposal" }),
            }],
        },
    )
    .expect("save proposal set");

    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();

    narrative_extraction::narrative_extraction_append_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.to_string(),
            revision_id,
            decision: "deferred".to_string(),
            decision_json: Some(decision_json),
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("defer");
}

#[test]
fn list_resumable_runs_excludes_already_satisfied_deferred_only() {
    let db = migrated_db();

    seed_deferred_proposal_with_decision(
        &db,
        "run-deferred-satisfied",
        "set-deferred-satisfied",
        "prop-deferred-satisfied",
        json!({ "reason": "already-satisfied" }),
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-deferred-satisfied".to_string())],
        "run",
    )
    .expect("mark completed");

    seed_deferred_proposal_with_decision(
        &db,
        "run-deferred-open",
        "set-deferred-open",
        "prop-deferred-open",
        json!({ "reason": "needs-more-context" }),
    );
    db.execute(
        "UPDATE narrative_extraction_runs SET status = 'completed', completed_at = datetime('now') WHERE id = ?",
        &[Value::String("run-deferred-open".to_string())],
        "run",
    )
    .expect("mark completed");

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("chronicle.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list");
    let ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();

    assert!(
        !ids.contains(&"run-deferred-satisfied"),
        "already-satisfied deferred alone must not keep run resumable"
    );
    assert!(
        ids.contains(&"run-deferred-open"),
        "deferred without already-satisfied must remain resumable"
    );
}
