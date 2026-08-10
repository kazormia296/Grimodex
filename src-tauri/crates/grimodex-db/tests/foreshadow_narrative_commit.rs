use grimodex_db::narrative_extraction::{
    self, ApplyCommitPayload, CommitOperation, CreateRunPayload, SaveProposalSetPayload,
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
        &[Value::String(scene_id.to_string()), Value::String(title.to_string())],
        "run",
    )
    .expect("insert scene");
}

fn setup_run_and_proposal_set(db: &Database, run_id: &str, proposal_set_id: &str) {
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
    narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "foreshadow.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![],
        },
    )
    .expect("save proposal set");
}

fn op(kind: &str, payload: Value) -> CommitOperation {
    CommitOperation {
        kind: kind.to_string(),
        payload,
        proposal_id: None,
        revision_id: None,
    }
}

fn build_apply(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    operations: Vec<CommitOperation>,
) -> ApplyCommitPayload {
    ApplyCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: proposal_set_id.to_string(),
        request_id: request_id.to_string(),
        plan_digest: plan_digest.to_string(),
        session_id: "sess-foreshadow".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications: vec![],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
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
    setup_run_and_proposal_set(&db, "run-fs-1", "set-fs-1");

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-1",
            "digest-fs-1",
            "set-fs-1",
            "run-fs-1",
            vec![op(
                "foreshadow.aggregate.create",
                aggregate_create("fs-1", "foreshadow-thread:watch"),
            )],
        ),
    )
    .expect("apply");

    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["entityBindings"]["foreshadowBindings"]["foreshadow-thread:watch"]["foreshadowId"], "fs-1");
    db.with_conn(|conn| {
        let root_count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))?;
        let setup_count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadow_setups", [], |r| r.get(0))?;
        let payoff_count: i64 = conn.query_row("SELECT COUNT(*) FROM foreshadow_payoffs", [], |r| r.get(0))?;
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
    setup_run_and_proposal_set(&db, "run-fs-2", "set-fs-2");
    let mut create = aggregate_create("fs-bad", "foreshadow-thread:bad");
    create["payoffs"][0]["sceneId"] = json!("missing-scene");

    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-2",
            "digest-fs-2",
            "set-fs-2",
            "run-fs-2",
            vec![op("foreshadow.aggregate.create", create)],
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
    setup_run_and_proposal_set(&db, "run-fs-3", "set-fs-3");
    let payload = build_apply(
        "req-fs-3",
        "digest-fs-3",
        "set-fs-3",
        "run-fs-3",
        vec![op(
            "foreshadow.aggregate.create",
            aggregate_create("fs-replay", "foreshadow-thread:replay"),
        )],
    );

    let first = narrative_extraction::narrative_extraction_apply_commit(&db, payload.clone()).expect("first apply");
    let second = narrative_extraction::narrative_extraction_apply_commit(&db, payload).expect("replay");
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
    setup_run_and_proposal_set(&db, "run-fs-4", "set-fs-4");
    narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-4-create",
            "digest-fs-4-create",
            "set-fs-4",
            "run-fs-4",
            vec![op(
                "foreshadow.aggregate.create",
                aggregate_create("fs-existing", "foreshadow-thread:existing"),
            )],
        ),
    )
    .expect("create");

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-fs-4-patch",
            "digest-fs-4-patch",
            "set-fs-4",
            "run-fs-4",
            vec![op(
                "foreshadow.aggregate.patch",
                json!({
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
                }),
            )],
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
