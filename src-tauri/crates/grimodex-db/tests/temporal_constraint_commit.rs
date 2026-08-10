use grimodex_db::narrative_extraction::{
    self, ApplyCommitPayload, CommitOperation, CreateRunPayload, SaveProposalSetPayload,
    UndoCommitPayload,
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

/// Runs / Proposal Sets are the atomic-commit provenance scope every
/// narrative apply commit requires (see `codex_phase_detail_commit.rs`).
/// Temporal operations exercised here carry no `proposalId`, so no
/// proposals need to be seeded or approved.
fn setup_run_and_proposal_set(db: &Database, run_id: &str, proposal_set_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "temporal.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "temporal" }),
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
            set_kind: "temporal.extract.review@1".to_string(),
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

fn node_ensure_op(node_id: &str, subject: Value) -> CommitOperation {
    op(
        "temporal.node.ensure",
        json!({
            "nodeId": node_id,
            "timelineKind": "primary",
            "subject": subject,
            "shape": "point",
        }),
    )
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
        session_id: "sess-temporal".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications: vec![],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

#[test]
fn constraint_scene_time_and_event_time_atomic_commit() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_event(&db, "event-1", "Event One");
    setup_run_and_proposal_set(&db, "run-1", "set-1");

    let ops = vec![
        node_ensure_op(
            "tn:scene:scene-1",
            json!({ "kind": "scene", "documentRef": "scene-1" }),
        ),
        node_ensure_op(
            "tn:event:event-1",
            json!({ "kind": "event", "eventId": "event-1" }),
        ),
        op(
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
        op(
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
        op(
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

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-atomic-1", "digest-atomic-1", "set-1", "run-1", ops),
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 5);

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| r.get(0))?;
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
    setup_run_and_proposal_set(&db, "run-2", "set-2");

    let ops = vec![
        node_ensure_op(
            "tn:scene:scene-2",
            json!({ "kind": "scene", "documentRef": "scene-2" }),
        ),
        node_ensure_op(
            "tn:event:event-2",
            json!({ "kind": "event", "eventId": "event-2" }),
        ),
        op(
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
        op(
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
        op(
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

    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-rollback-1", "digest-rollback-1", "set-2", "run-2", ops),
    )
    .expect_err("should fail on the event OCC mismatch");
    assert!(err.to_string().contains("NEX_TEMPORAL_EVENT_VERSION_MISMATCH"));

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| r.get(0))?;
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
        let event_version: i64 = conn.query_row(
            "SELECT version FROM events WHERE id = 'event-2'",
            [],
            |r| r.get(0),
        )?;
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
    setup_run_and_proposal_set(&db, "run-3", "set-3");

    let first_ops = vec![
        node_ensure_op(
            "tn:scene:scene-3",
            json!({ "kind": "scene", "documentRef": "scene-3" }),
        ),
        op(
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
    narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-dup-1", "digest-dup-1", "set-3", "run-3", first_ops),
    )
    .expect("first commit applies");

    // Same subject, different client-chosen nodeId: rejected as a semantic
    // duplicate rather than silently created a second time.
    let duplicate_node_ops = vec![node_ensure_op(
        "tn:scene:scene-3-again",
        json!({ "kind": "scene", "documentRef": "scene-3" }),
    )];
    let node_err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-dup-2",
            "digest-dup-2",
            "set-3",
            "run-3",
            duplicate_node_ops,
        ),
    )
    .expect_err("duplicate node subject must be rejected");
    assert!(node_err
        .to_string()
        .contains("NEX_TEMPORAL_NODE_SEMANTIC_DUPLICATE"));

    // Same constraint edge (same kind + nodeId): rejected as a semantic
    // duplicate.
    let duplicate_constraint_ops = vec![op(
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
    let constraint_err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-dup-3",
            "digest-dup-3",
            "set-3",
            "run-3",
            duplicate_constraint_ops,
        ),
    )
    .expect_err("duplicate constraint edge must be rejected");
    assert!(constraint_err
        .to_string()
        .contains("NEX_TEMPORAL_CONSTRAINT_SEMANTIC_DUPLICATE"));

    db.with_conn(|conn| {
        let node_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM narrative_temporal_nodes", [], |r| r.get(0))?;
        let constraint_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_temporal_constraints",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(node_count, 1, "only the first node must survive");
        assert_eq!(constraint_count, 1, "only the first constraint must survive");
        Ok(())
    })
    .unwrap();
}

#[test]
fn undo_restores_scene_chronicle_with_a_version_bump_not_a_rewind() {
    let db = migrated_db();
    seed_scene(&db, "scene-4", "Scene Four");
    setup_run_and_proposal_set(&db, "run-4", "set-4");

    let ops = vec![op(
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-undo-1", "digest-undo-1", "set-4", "run-4", ops),
    )
    .expect("apply");
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
            request_id: None,
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

    db.with_conn(|conn| {
        let (start_time, start_granularity, version): (Option<i64>, String, i64) = conn
            .query_row(
                "SELECT chronicle_start_time, chronicle_start_granularity, version
                   FROM tree_nodes WHERE id = 'scene-4'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
        assert_eq!(start_time, None, "chronicle fields are restored to pre-patch state");
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
    setup_run_and_proposal_set(&db, "run-5", "set-5");

    let ops = vec![op(
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-block-1", "digest-block-1", "set-5", "run-5", ops),
    )
    .expect("apply");
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
            request_id: None,
        },
    )
    .expect_err("human edit should block undo");
    assert!(err.to_string().contains("NEX_COMMIT_SCENE_EDITED"));
}
