use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, ProposalSeed, SaveProposalSetPayload,
};
use grimodex_db::Database;
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
            surface_path_id: "plot.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "plot" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
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
        })
        .collect();

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "plot.extract.review@1".to_string(),
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

fn build_apply(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, String, Value)>,
) -> ApplyCommitPayload {
    let operations: Vec<CommitOperation> = ops
        .iter()
        .map(|(proposal_id, revision_id, kind, payload)| CommitOperation {
            kind: kind.clone(),
            payload: payload.clone(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
        })
        .collect();
    let applications: Vec<CommitApplicationRef> = ops
        .iter()
        .map(|(proposal_id, revision_id, _, _)| CommitApplicationRef {
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
        session_id: "sess-plot".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
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

fn thread_create(thread_id: &str, hypothesis_id: &str, name: &str) -> Value {
    json!({
        "threadId": thread_id,
        "hypothesisId": hypothesis_id,
        "name": name,
        "description": null,
        "color": "#aabbcc",
        "sortOrder": "a0"
    })
}

fn marker_create(
    marker_id: &str,
    hypothesis_id: &str,
    scene_id: &str,
    phase_type: &str,
) -> Value {
    json!({
        "markerId": marker_id,
        "hypothesisId": hypothesis_id,
        "threadId": null,
        "sceneId": scene_id,
        "phaseType": phase_type,
        "note": "note"
    })
}

#[test]
fn plot_thread_and_markers_atomic_commit() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let items = [
        (
            "plot.thread.create",
            thread_create("thread-a", "plot-thread:west", "西部戦線"),
        ),
        (
            "plot.marker.create",
            marker_create("m1", "plot-thread:west", "scene-1", "introduce"),
        ),
        (
            "plot.marker.create",
            marker_create("m2", "plot-thread:west", "scene-2", "develop"),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-plot-1", "set-plot-1", &items);

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-plot-1",
            "digest-plot-1",
            "set-plot-1",
            "run-plot-1",
            zip_ops(&pairs, &items),
        ),
    )
    .expect("apply");

    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);
    assert_eq!(
        applied["entityBindings"]["plotThreadBindings"]["plot-thread:west"]["plotThreadId"],
        "thread-a"
    );

    db.with_conn(|conn| {
        let thread_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_threads", [], |r| r.get(0))?;
        let marker_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_thread_scene_links", [], |r| r.get(0))?;
        let version: i64 = conn.query_row(
            "SELECT version FROM plot_threads WHERE id = 'thread-a'",
            [],
            |r| r.get(0),
        )?;
        let semantic_key: String = conn.query_row(
            "SELECT semantic_key FROM plot_thread_scene_links WHERE id = 'm1'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(thread_count, 1);
        assert_eq!(marker_count, 2);
        assert_eq!(version, 0);
        assert_eq!(semantic_key, "thread-a|scene-1|introduce");
        Ok(())
    })
    .unwrap();
}

#[test]
fn plot_marker_failure_rolls_back_entire_commit() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");

    let items = [
        (
            "plot.thread.create",
            thread_create("thread-b", "plot-thread:b", "Thread B"),
        ),
        (
            "plot.marker.create",
            marker_create("m-bad", "plot-thread:b", "scene-1", "invalid-phase"),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-plot-2", "set-plot-2", &items);

    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-plot-2",
            "digest-plot-2",
            "set-plot-2",
            "run-plot-2",
            zip_ops(&pairs, &items),
        ),
    )
    .expect_err("bad phase should fail");

    assert!(err.to_string().contains("invalid phase_type"));

    db.with_conn(|conn| {
        let thread_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_threads", [], |r| r.get(0))?;
        let marker_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_thread_scene_links", [], |r| r.get(0))?;
        assert_eq!(thread_count, 0);
        assert_eq!(marker_count, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn plot_request_id_replay_does_not_duplicate() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");

    let items = [
        (
            "plot.thread.create",
            thread_create("thread-c", "plot-thread:c", "Thread C"),
        ),
        (
            "plot.marker.create",
            marker_create("m-c1", "plot-thread:c", "scene-1", "introduce"),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-plot-3", "set-plot-3", &items);
    let payload = build_apply(
        "req-plot-3",
        "digest-plot-3",
        "set-plot-3",
        "run-plot-3",
        zip_ops(&pairs, &items),
    );

    let first = narrative_extraction::narrative_extraction_apply_commit(&db, payload.clone())
        .expect("first apply");
    let second = narrative_extraction::narrative_extraction_apply_commit(&db, payload)
        .expect("replay");

    assert_eq!(first["commitId"], second["commitId"]);
    assert_eq!(second["idempotentReplay"], true);

    db.with_conn(|conn| {
        let thread_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_threads", [], |r| r.get(0))?;
        let marker_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_thread_scene_links", [], |r| r.get(0))?;
        assert_eq!(thread_count, 1);
        assert_eq!(marker_count, 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn plot_two_threads_merge_branch_at_same_scene() {
    let db = migrated_db();
    seed_scene(&db, "scene-merge", "Merge Scene");

    let items = [
        (
            "plot.thread.create",
            thread_create("thread-from", "plot-thread:from", "From Thread"),
        ),
        (
            "plot.thread.create",
            json!({
                "threadId": "thread-to",
                "hypothesisId": "plot-thread:to",
                "name": "To Thread",
                "description": null,
                "color": null,
                "sortOrder": "a1"
            }),
        ),
        (
            "plot.marker.create",
            marker_create("m-from", "plot-thread:from", "scene-merge", "climax"),
        ),
        (
            "plot.marker.create",
            marker_create("m-to", "plot-thread:to", "scene-merge", "introduce"),
        ),
        (
            "plot.branch.create",
            json!({
                "branchId": "branch-merge",
                "fromHypothesisId": "plot-thread:from",
                "toHypothesisId": "plot-thread:to",
                "fromThreadId": null,
                "toThreadId": null,
                "atSceneId": "scene-merge",
                "kind": "merge",
                "semanticKey": null
            }),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-plot-4", "set-plot-4", &items);

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-plot-4",
            "digest-plot-4",
            "set-plot-4",
            "run-plot-4",
            zip_ops(&pairs, &items),
        ),
    )
    .expect("apply merge branch");

    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 5);

    db.with_conn(|conn| {
        let branch_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM plot_thread_branches", [], |r| r.get(0))?;
        let semantic_key: String = conn.query_row(
            "SELECT semantic_key FROM plot_thread_branches WHERE id = 'branch-merge'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(branch_count, 1);
        assert_eq!(semantic_key, "thread-from|thread-to|scene-merge|merge");
        Ok(())
    })
    .unwrap();
}
