use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, CreateTaskSeed, PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload,
    UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
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
    db
}

fn test_envelope(run_id: &str, task_id: &str) -> Value {
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{
        "inputRef": source_key,
        "kind": "snapshot-document",
        "revisionToken": "revision-1"
    }]);
    json!({
        "schemaVersion": 1, "runId": run_id, "taskId": task_id,
        "reconcilerId": "test.reconciler", "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "narrative.test", "proposalSchemaVersion": "1",
        "sourceBasis": [{"sourceKind":"snapshot-document","sourceKey":source_key,"revisionToken":"revision-1"}],
        "evidenceSet": [], "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn seed_scene(db: &Database, scene_id: &str, title: &str) {
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES (?, 'project-1', 'scene', ?)",
        &[
            Value::String(scene_id.to_string()),
            Value::String(title.to_string()),
        ],
        "run",
    )
    .expect("insert scene");
}

fn seed_event(db: &Database, event_id: &str, title: &str) {
    db.execute(
        "INSERT INTO events (id, project_id, title) VALUES (?, 'project-1', ?)",
        &[
            Value::String(event_id.to_string()),
            Value::String(title.to_string()),
        ],
        "run",
    )
    .expect("insert event");
}

fn seed_approved_proposals(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    items: &[(&str, Value)],
) -> Vec<(String, String)> {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "temporal.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "temporal" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(format!("{run_id}-task")),
                task_kind: "extract_window".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let proposals: Vec<ProposalSeed> = items
        .iter()
        .enumerate()
        .map(|(index, (kind, payload))| ProposalSeed {
            proposal_id: Some(format!("{run_id}-prop-{index}")),
            proposal_key: format!("{run_id}-key-{index}"),
            kind: (*kind).to_string(),
            payload_json: payload.clone(),
            reconciliation_envelope: Some(test_envelope(run_id, &format!("{run_id}-task"))),
        })
        .collect();

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "temporal.extract.review@1".to_string(),
            summary_json: None,
            proposals,
        },
    )
    .expect("save proposal set");

    let mut pairs = Vec::new();
    for proposal in saved["proposals"].as_array().expect("proposals") {
        let proposal_id = proposal["proposalId"].as_str().unwrap().to_string();
        let revision_id = proposal["revisionId"].as_str().unwrap().to_string();
        narrative_extraction::narrative_extraction_append_human_decision(
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

fn node_ensure_payload(node_id: &str, subject: Value) -> Value {
    json!({
        "nodeId": node_id,
        "timelineKind": "primary",
        "subject": subject,
        "shape": "point",
    })
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

fn build_prepare(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, String, Value)>,
) -> PrepareCommitPayload {
    let operations: Vec<CommitOperation> = ops
        .iter()
        .map(
            |(proposal_id, revision_id, kind, payload)| CommitOperation {
                kind: kind.clone(),
                payload: payload.clone(),
                proposal_id: proposal_id.clone(),
                revision_id: revision_id.clone(),
            },
        )
        .collect();
    let applications: Vec<CommitApplicationRef> = ops
        .iter()
        .map(|(proposal_id, revision_id, _, _)| CommitApplicationRef {
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
        session_id: "sess-temporal".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

fn prepare_and_apply(db: &Database, prepare: PrepareCommitPayload) -> Value {
    enable_manual_apply(db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(db, prepare.clone())
        .expect("prepare");
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("preparedCommitId")
                .to_string(),
            request_id: prepare.request_id.clone(),
            session_id: prepare.session_id.clone(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply")
}

fn prepare_then_apply(db: &Database, prepare: PrepareCommitPayload) -> anyhow::Result<Value> {
    enable_manual_apply(db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(db, prepare.clone())?;
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: prepare.project_id,
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing preparedCommitId"))?
                .to_string(),
            request_id: prepare.request_id,
            session_id: prepare.session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
}

fn zip_ops(
    pairs: &[(String, String)],
    items: &[(&str, Value)],
) -> Vec<(String, String, String, Value)> {
    pairs
        .iter()
        .zip(items.iter())
        .map(|((proposal_id, revision_id), (kind, payload))| {
            (
                proposal_id.clone(),
                revision_id.clone(),
                (*kind).to_string(),
                payload.clone(),
            )
        })
        .collect()
}

#[test]
fn constraint_scene_time_and_event_time_atomic_commit() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_event(&db, "event-1", "Event One");

    let items = [
        (
            "temporal.node.ensure",
            node_ensure_payload(
                "tn:scene:scene-1",
                json!({ "kind": "scene", "documentRef": "scene-1" }),
            ),
        ),
        (
            "temporal.node.ensure",
            node_ensure_payload(
                "tn:event:event-1",
                json!({ "kind": "event", "eventId": "event-1" }),
            ),
        ),
        (
            "temporal.constraint.create",
            json!({
                "kind": "duration",
                "nodeId": "tn:scene:scene-1",
                "duration": { "min": 10, "max": 20, "unit": "minute" },
                "authority": "model-inferred",
                "strictness": "soft",
                "sourceIds": [],
            }),
        ),
        (
            "temporal.scene.metadata.patch",
            json!({
                "sceneId": "scene-1",
                "baseVersion": 0,
                "startTime": 5,
                "startMinute": 480,
                "startGranularity": "time",
                "endTime": 5,
                "endMinute": 540,
                "endGranularity": "time",
                "precision": "exact",
            }),
        ),
        (
            "temporal.event.metadata.patch",
            json!({
                "eventId": "event-1",
                "baseVersion": 0,
                "startTime": 5,
                "startMinute": 480,
                "startGranularity": "time",
                "endTime": 5,
                "endMinute": 500,
                "endGranularity": "time",
                "precision": "exact",
            }),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-1", "set-1", &items);

    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-atomic-1",
            "digest-atomic-1",
            "set-1",
            "run-1",
            zip_ops(&pairs, &items),
        ),
    );
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 5);

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| {
                r.get(0)
            })?;
        let constraint_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_temporal_constraints",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(node_count, 2);
        assert_eq!(constraint_count, 1);

        let (scene_start, scene_end_minute, scene_version): (i64, i64, i64) = conn.query_row(
            "SELECT chronicle_start_time, chronicle_end_minute, version
               FROM tree_nodes WHERE id = 'scene-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(scene_start, 5);
        assert_eq!(scene_end_minute, 540);
        assert_eq!(scene_version, 1);

        let (event_start, event_end_minute, event_version): (i64, i64, i64) = conn.query_row(
            "SELECT start_time, end_minute, version FROM events WHERE id = 'event-1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(event_start, 5);
        assert_eq!(event_end_minute, 500);
        assert_eq!(event_version, 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn one_occ_failure_rolls_back_the_whole_temporal_commit() {
    let db = migrated_db();
    seed_scene(&db, "scene-2", "Scene Two");
    seed_event(&db, "event-2", "Event Two");

    let items = [
        (
            "temporal.node.ensure",
            node_ensure_payload(
                "tn:scene:scene-2",
                json!({ "kind": "scene", "documentRef": "scene-2" }),
            ),
        ),
        (
            "temporal.node.ensure",
            node_ensure_payload(
                "tn:event:event-2",
                json!({ "kind": "event", "eventId": "event-2" }),
            ),
        ),
        (
            "temporal.constraint.create",
            json!({
                "kind": "duration",
                "nodeId": "tn:scene:scene-2",
                "duration": { "min": 10, "max": 20, "unit": "minute" },
                "authority": "model-inferred",
                "strictness": "soft",
                "sourceIds": [],
            }),
        ),
        (
            "temporal.scene.metadata.patch",
            json!({
                "sceneId": "scene-2",
                "baseVersion": 0,
                "startTime": 5,
                "startMinute": 480,
                "startGranularity": "time",
                "endTime": 5,
                "endMinute": 540,
                "endGranularity": "time",
                "precision": "exact",
            }),
        ),
        (
            "temporal.event.metadata.patch",
            json!({
                "eventId": "event-2",
                // Wrong on purpose: event-2 is still at version 0.
                "baseVersion": 5,
                "startTime": 5,
                "startMinute": 480,
                "startGranularity": "time",
                "endTime": 5,
                "endMinute": 500,
                "endGranularity": "time",
                "precision": "exact",
            }),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-2", "set-2", &items);

    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-rollback-1",
            "digest-rollback-1",
            "set-2",
            "run-2",
            zip_ops(&pairs, &items),
        ),
    )
    .expect_err("should fail on the event OCC mismatch");
    assert!(err
        .to_string()
        .contains("NEX_TEMPORAL_EVENT_VERSION_MISMATCH"));

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| {
                r.get(0)
            })?;
        let constraint_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_temporal_constraints",
            [],
            |r| r.get(0),
        )?;
        let (scene_start, scene_version): (Option<i64>, i64) = conn.query_row(
            "SELECT chronicle_start_time, version FROM tree_nodes WHERE id = 'scene-2'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let event_version: i64 =
            conn.query_row("SELECT version FROM events WHERE id = 'event-2'", [], |r| {
                r.get(0)
            })?;
        assert_eq!(node_count, 0, "node.ensure must roll back with the rest");
        assert_eq!(constraint_count, 0);
        assert_eq!(scene_start, None, "scene patch must roll back");
        assert_eq!(scene_version, 0);
        assert_eq!(event_version, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn semantic_duplicates_are_rejected_for_nodes_and_constraints() {
    let db = migrated_db();
    seed_scene(&db, "scene-3", "Scene Three");

    let first_items = [
        (
            "temporal.node.ensure",
            node_ensure_payload(
                "tn:scene:scene-3",
                json!({ "kind": "scene", "documentRef": "scene-3" }),
            ),
        ),
        (
            "temporal.constraint.create",
            json!({
                "kind": "duration",
                "nodeId": "tn:scene:scene-3",
                "duration": { "min": 10, "max": 20, "unit": "minute" },
                "authority": "model-inferred",
                "strictness": "soft",
                "sourceIds": [],
            }),
        ),
    ];
    let first_pairs = seed_approved_proposals(&db, "run-3a", "set-3a", &first_items);
    prepare_and_apply(
        &db,
        build_prepare(
            "req-dup-1",
            "digest-dup-1",
            "set-3a",
            "run-3a",
            zip_ops(&first_pairs, &first_items),
        ),
    );

    // Same subject, different client-chosen nodeId: rejected as a semantic
    // duplicate rather than silently created a second time.
    let duplicate_node_items = [(
        "temporal.node.ensure",
        node_ensure_payload(
            "tn:scene:scene-3-again",
            json!({ "kind": "scene", "documentRef": "scene-3" }),
        ),
    )];
    let dup_node_pairs = seed_approved_proposals(&db, "run-3b", "set-3b", &duplicate_node_items);
    let node_err = prepare_then_apply(
        &db,
        build_prepare(
            "req-dup-2",
            "digest-dup-2",
            "set-3b",
            "run-3b",
            zip_ops(&dup_node_pairs, &duplicate_node_items),
        ),
    )
    .expect_err("duplicate node subject must be rejected");
    assert!(node_err
        .to_string()
        .contains("NEX_TEMPORAL_NODE_SEMANTIC_DUPLICATE"));

    // Same constraint edge (same kind + nodeId): rejected as a semantic
    // duplicate.
    let duplicate_constraint_items = [(
        "temporal.constraint.create",
        json!({
            "kind": "duration",
            "nodeId": "tn:scene:scene-3",
            "duration": { "min": 15, "max": 25, "unit": "minute" },
            "authority": "model-inferred",
            "strictness": "soft",
            "sourceIds": [],
        }),
    )];
    let dup_constraint_pairs =
        seed_approved_proposals(&db, "run-3c", "set-3c", &duplicate_constraint_items);
    let constraint_err = prepare_then_apply(
        &db,
        build_prepare(
            "req-dup-3",
            "digest-dup-3",
            "set-3c",
            "run-3c",
            zip_ops(&dup_constraint_pairs, &duplicate_constraint_items),
        ),
    )
    .expect_err("duplicate constraint edge must be rejected");
    assert!(constraint_err
        .to_string()
        .contains("NEX_TEMPORAL_CONSTRAINT_SEMANTIC_DUPLICATE"));

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| {
                r.get(0)
            })?;
        let constraint_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_temporal_constraints",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(node_count, 1, "only the first node must survive");
        assert_eq!(
            constraint_count, 1,
            "only the first constraint must survive"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn ensuring_an_existing_node_commits_without_a_false_feed_mutation() {
    let db = migrated_db();
    seed_scene(&db, "scene-existing", "Existing Scene");
    let node = [(
        "temporal.node.ensure",
        node_ensure_payload(
            "tn:scene:existing",
            json!({ "kind": "scene", "documentRef": "scene-existing" }),
        ),
    )];

    let first_pairs = seed_approved_proposals(&db, "run-existing-a", "set-existing-a", &node);
    let first = prepare_and_apply(
        &db,
        build_prepare(
            "req-existing-a",
            "digest-existing-a",
            "set-existing-a",
            "run-existing-a",
            zip_ops(&first_pairs, &node),
        ),
    );
    assert!(first["maintenanceTransactionId"].is_string());

    let second_pairs = seed_approved_proposals(&db, "run-existing-b", "set-existing-b", &node);
    let second = prepare_and_apply(
        &db,
        build_prepare(
            "req-existing-b",
            "digest-existing-b",
            "set-existing-b",
            "run-existing-b",
            zip_ops(&second_pairs, &node),
        ),
    );
    assert_eq!(second["status"], "applied");
    assert!(second.get("maintenanceTransactionId").is_none());

    db.with_conn(|conn| {
        let feed_transactions: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            feed_transactions, 1,
            "the second no-op ensure must not create a freshness mutation"
        );
        let second_commit_id = second["commitId"].as_str().expect("second commit id");
        let journal: String = conn.query_row(
            "SELECT after_json FROM narrative_commit_journals WHERE commit_id = ?1",
            [second_commit_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<Value>(&journal)?["entities"][0]["opKind"],
            "ensure-existing",
            "the immutable journal must retain the no-op operation"
        );
        Ok(())
    })
    .expect("inspect no-op commit");
}

#[test]
fn undo_restores_scene_chronicle_with_a_version_bump_not_a_rewind() {
    let db = migrated_db();
    seed_scene(&db, "scene-4", "Scene Four");

    let items = [(
        "temporal.scene.metadata.patch",
        json!({
            "sceneId": "scene-4",
            "baseVersion": 0,
            "startTime": 5,
            "startMinute": 480,
            "startGranularity": "time",
            "endTime": 5,
            "endMinute": 540,
            "endGranularity": "time",
            "precision": "exact",
        }),
    )];
    let pairs = seed_approved_proposals(&db, "run-4", "set-4", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-undo-1",
            "digest-undo-1",
            "set-4",
            "run-4",
            zip_ops(&pairs, &items),
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    db.with_conn(|conn| {
        let version: i64 = conn.query_row(
            "SELECT version FROM tree_nodes WHERE id = 'scene-4'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(version, 1, "patch bumps version 0 -> 1");
        Ok(())
    })
    .unwrap();

    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-temporal".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("temporal-constraint-undo".to_string()),
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

    db.with_conn(|conn| {
        let (start_time, start_granularity, version): (Option<i64>, String, i64) = conn.query_row(
            "SELECT chronicle_start_time, chronicle_start_granularity, version
                   FROM tree_nodes WHERE id = 'scene-4'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        assert_eq!(
            start_time, None,
            "chronicle fields are restored to pre-patch state"
        );
        assert_eq!(start_granularity, "none");
        assert_eq!(
            version, 2,
            "undo bumps the version again instead of rewinding to 0"
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn human_edited_scene_after_commit_blocks_undo() {
    let db = migrated_db();
    seed_scene(&db, "scene-5", "Scene Five");

    let items = [(
        "temporal.scene.metadata.patch",
        json!({
            "sceneId": "scene-5",
            "baseVersion": 0,
            "startTime": 5,
            "startMinute": 480,
            "startGranularity": "time",
            "endTime": 5,
            "endMinute": 540,
            "endGranularity": "time",
            "precision": "exact",
        }),
    )];
    let pairs = seed_approved_proposals(&db, "run-5", "set-5", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-block-1",
            "digest-block-1",
            "set-5",
            "run-5",
            zip_ops(&pairs, &items),
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    // Simulate a human edit landing after the commit (e.g. from the editor)
    // that bumps the scene's version independently of this apply commit.
    db.execute(
        "UPDATE tree_nodes SET title = 'Edited By Human', version = 2 WHERE id = 'scene-5'",
        &[],
        "run",
    )
    .expect("simulate human edit");

    let err = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-temporal".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("temporal-edited-undo".to_string()),
        },
    )
    .expect_err("human edit should block undo");
    assert!(err.to_string().contains("NEX_COMMIT_SCENE_EDITED"));
}
