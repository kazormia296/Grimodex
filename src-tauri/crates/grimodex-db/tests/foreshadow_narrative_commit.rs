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
            surface_path_id: "foreshadow.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "foreshadow" }),
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
            set_kind: "foreshadow.extract.review@1".to_string(),
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
        session_id: "sess-foreshadow".to_string(),
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

fn aggregate_create(foreshadow_id: &str, hypothesis_id: &str) -> Value {
    json!({
        "foreshadowId": foreshadow_id,
        "hypothesisId": hypothesis_id,
        "title": "The watch stops",
        "intent": "Plant the stopped watch before its final use.",
        "mechanism": "object-use",
        "secret": true,
        "setups": [{
            "setupId": "su-1",
            "sceneId": "scene-1",
            "fromPos": 0,
            "toPos": 10,
            "role": "plant",
            "kind": "designated_existing",
            "aiStrength": null,
            "rationale": "The watch is introduced.",
            "semanticKey": "watch-plant"
        }],
        "payoffs": [{
            "payoffId": "po-1",
            "sceneId": "scene-2",
            "fromPos": 0,
            "toPos": 8,
            "role": "final",
            "confirmed": true,
            "primary": true,
            "rationale": "The watch reveals the killer's timing.",
            "semanticKey": null
        }],
        "supportEdges": [{
            "setupId": "su-1",
            "payoffId": "po-1",
            "bridgeKind": "direct-use",
            "explanation": "The planted watch is used directly."
        }],
        "codexEntryIds": []
    })
}

#[test]
fn foreshadow_aggregate_create_is_atomic() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-1", "foreshadow-thread:watch"),
    )];
    let pairs = seed_approved_proposals(&db, "run-fs-1", "set-fs-1", &items);

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-1",
            "digest-fs-1",
            "set-fs-1",
            "run-fs-1",
            zip_ops(&pairs, &items),
        ),
    )
    .expect("apply");

    assert_eq!(applied["status"], "applied");
    assert_eq!(
        applied["entityBindings"]["foreshadowBindings"]["foreshadow-thread:watch"]["foreshadowId"],
        "fs-1"
    );
    db.with_conn(|conn| {
        let root_count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))?;
        let setup_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM foreshadow_setups", [], |r| r.get(0))?;
        let payoff_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM foreshadow_payoffs", [], |r| r.get(0))?;
        let edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM foreshadow_setup_payoff_links",
            [],
            |r| r.get(0),
        )?;
        assert_eq!((root_count, setup_count, payoff_count, edge_count), (1, 1, 1, 1));
        Ok(())
    })
    .unwrap();
}

#[test]
fn payoff_failure_rolls_back_foreshadow_root() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    let mut create = aggregate_create("fs-bad", "foreshadow-thread:bad");
    create["payoffs"][0]["sceneId"] = json!("missing-scene");

    let items = [("foreshadow.aggregate.create", create)];
    let pairs = seed_approved_proposals(&db, "run-fs-2", "set-fs-2", &items);

    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-2",
            "digest-fs-2",
            "set-fs-2",
            "run-fs-2",
            zip_ops(&pairs, &items),
        ),
    )
    .expect_err("missing payoff scene should fail");
    assert!(err.to_string().contains("scene 'missing-scene'"));
    db.with_conn(|conn| {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))?;
        assert_eq!(count, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn foreshadow_request_replay_does_not_duplicate() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-replay", "foreshadow-thread:replay"),
    )];
    let pairs = seed_approved_proposals(&db, "run-fs-3", "set-fs-3", &items);
    let payload = build_apply(
        "req-fs-3",
        "digest-fs-3",
        "set-fs-3",
        "run-fs-3",
        zip_ops(&pairs, &items),
    );

    let first =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload.clone()).expect("first");
    let second =
        narrative_extraction::narrative_extraction_apply_commit(&db, payload).expect("replay");
    assert_eq!(first["commitId"], second["commitId"]);
    assert_eq!(second["idempotentReplay"], true);
    db.with_conn(|conn| {
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))?;
        assert_eq!(count, 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn foreshadow_patch_adds_setup_and_bumps_version() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let create_items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-existing", "foreshadow-thread:existing"),
    )];
    let create_pairs = seed_approved_proposals(&db, "run-fs-4a", "set-fs-4a", &create_items);
    narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-4-create",
            "digest-fs-4-create",
            "set-fs-4a",
            "run-fs-4a",
            zip_ops(&create_pairs, &create_items),
        ),
    )
    .expect("create");

    let patch_payload = json!({
        "foreshadowId": "fs-existing",
        "hypothesisId": "foreshadow-thread:existing",
        "baseVersion": 0,
        "intent": { "kind": "fill-if-empty", "value": "Updated intent" },
        "mechanism": { "kind": "set-if-empty", "value": "clue-solution" },
        "addSetups": [{
            "setupId": "su-2",
            "sceneId": "scene-2",
            "fromPos": 10,
            "toPos": 20,
            "role": "echo",
            "kind": "designated_existing",
            "aiStrength": null,
            "rationale": "A later reminder.",
            "semanticKey": null
        }],
        "addPayoffs": [],
        "addSupportEdges": [],
        "addCodexEntryIds": []
    });
    let patch_items = [("foreshadow.aggregate.patch", patch_payload)];
    let patch_pairs = seed_approved_proposals(&db, "run-fs-4b", "set-fs-4b", &patch_items);

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-4-patch",
            "digest-fs-4-patch",
            "set-fs-4b",
            "run-fs-4b",
            zip_ops(&patch_pairs, &patch_items),
        ),
    )
    .expect("patch");
    assert_eq!(applied["created"][0]["version"], 1);
    db.with_conn(|conn| {
        let version: i64 = conn.query_row(
            "SELECT version FROM foreshadows WHERE id = 'fs-existing'",
            [],
            |r| r.get(0),
        )?;
        let setup_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = 'fs-existing'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(version, 1);
        assert_eq!(setup_count, 2);
        Ok(())
    })
    .unwrap();
}
