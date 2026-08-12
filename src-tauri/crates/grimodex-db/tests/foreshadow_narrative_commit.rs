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

type CreateReplayRootState = (i64, Option<String>, Option<i64>, Option<i64>, i64);
type PatchReplayRootState = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    i64,
    i64,
);

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

fn seed_codex_entry(db: &Database, entry_id: &str) {
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id,
             version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'Watch', '[]', '', '{}', NULL, 0, 't', 't')",
        &[Value::String(entry_id.to_string())],
        "run",
    )
    .expect("insert Codex entry");
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
        session_id: "sess-foreshadow".to_string(),
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

fn undo_payload(commit_id: &str) -> UndoCommitPayload {
    UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess-foreshadow".to_string(),
        surface: None,
        commit_id: Some(commit_id.to_string()),
        request_id: None,
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

    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-1",
            "digest-fs-1",
            "set-fs-1",
            "run-fs-1",
            zip_ops(&pairs, &items),
        ),
    );

    assert_eq!(applied["status"], "applied");
    assert_eq!(
        applied["entityBindings"]["foreshadowBindings"]["foreshadow-thread:watch"]["foreshadowId"],
        "fs-1"
    );
    db.with_conn(|conn| {
        let root_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM foreshadows", [], |r| r.get(0))?;
        let setup_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM foreshadow_setups", [], |r| r.get(0))?;
        let payoff_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM foreshadow_payoffs", [], |r| r.get(0))?;
        let edge_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM foreshadow_setup_payoff_links",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            (root_count, setup_count, payoff_count, edge_count),
            (1, 1, 1, 1)
        );
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

    let err = {
        enable_manual_apply(&db);
        let prepare = build_prepare(
            "req-fs-2",
            "digest-fs-2",
            "set-fs-2",
            "run-fs-2",
            zip_ops(&pairs, &items),
        );
        let prepared = narrative_extraction::narrative_extraction_prepare_commit(&db, prepare)
            .expect("prepare");
        narrative_extraction::narrative_extraction_apply_commit(
            &db,
            ApplyCommitPayload {
                project_id: "project-1".to_string(),
                prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
                request_id: "req-fs-2".to_string(),
                session_id: "sess-foreshadow".to_string(),
                expected_version: prepared["version"].as_i64(),
            },
        )
        .expect_err("missing payoff scene should fail")
    };
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
    let payload = build_prepare(
        "req-fs-3",
        "digest-fs-3",
        "set-fs-3",
        "run-fs-3",
        zip_ops(&pairs, &items),
    );

    let first = prepare_and_apply(&db, payload.clone());
    let second = prepare_and_apply(&db, payload);
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
    let _created = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-4-create",
            "digest-fs-4-create",
            "set-fs-4a",
            "run-fs-4a",
            zip_ops(&create_pairs, &create_items),
        ),
    );

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

    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-4-patch",
            "digest-fs-4-patch",
            "set-fs-4b",
            "run-fs-4b",
            zip_ops(&patch_pairs, &patch_items),
        ),
    );
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

#[test]
fn foreshadow_create_apply_undo_redo_restores_complete_aggregate() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-create-cycle", "foreshadow-thread:create-cycle"),
    )];
    let pairs = seed_approved_proposals(&db, "run-fs-create-cycle", "set-fs-create-cycle", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-create-cycle",
            "digest-fs-create-cycle",
            "set-fs-create-cycle",
            "run-fs-create-cycle",
            zip_ops(&pairs, &items),
        ),
    );
    let commit_id = applied["commitId"].as_str().expect("commit id");

    let undone =
        narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload(commit_id))
            .expect("undo foreshadow create");
    assert_eq!(undone["status"], "undone");
    db.with_conn(|conn| {
        let counts: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM foreshadows WHERE id = 'fs-create-cycle'),
                (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = 'fs-create-cycle'),
                (SELECT COUNT(*) FROM foreshadow_payoffs WHERE foreshadow_id = 'fs-create-cycle'),
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links WHERE foreshadow_id = 'fs-create-cycle')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(counts, (0, 0, 0, 0));
        Ok(())
    })
    .unwrap();

    let redone =
        narrative_extraction::narrative_extraction_redo_commit(&db, undo_payload(commit_id))
            .expect("redo foreshadow create");
    assert_eq!(redone["status"], "redone");
    db.with_conn(|conn| {
        let root: CreateReplayRootState = conn.query_row(
            "SELECT version, payoff_scene_id, payoff_from_pos, payoff_to_pos, payoff_confirmed
               FROM foreshadows
              WHERE id = 'fs-create-cycle' AND project_id = 'project-1'",
            [],
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
        let counts: (i64, i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = 'fs-create-cycle'),
                (SELECT COUNT(*) FROM foreshadow_payoffs WHERE foreshadow_id = 'fs-create-cycle'),
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links WHERE foreshadow_id = 'fs-create-cycle')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(root, (1, Some("scene-2".to_string()), Some(0), Some(8), 1));
        assert_eq!(counts, (1, 1, 1));
        Ok(())
    })
    .unwrap();
}

#[test]
fn foreshadow_patch_apply_undo_redo_restores_every_child_type_and_mirror() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");
    seed_scene(&db, "scene-3", "Scene Three");
    seed_codex_entry(&db, "codex-watch");

    let mut initial = aggregate_create("fs-patch-cycle", "foreshadow-thread:patch-cycle");
    initial["intent"] = Value::Null;
    initial["mechanism"] = Value::Null;
    initial["payoffs"][0]["primary"] = json!(false);
    initial["payoffs"][0]["confirmed"] = json!(false);
    let create_items = [("foreshadow.aggregate.create", initial)];
    let create_pairs = seed_approved_proposals(
        &db,
        "run-fs-patch-cycle-create",
        "set-fs-patch-cycle-create",
        &create_items,
    );
    prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-patch-cycle-create",
            "digest-fs-patch-cycle-create",
            "set-fs-patch-cycle-create",
            "run-fs-patch-cycle-create",
            zip_ops(&create_pairs, &create_items),
        ),
    );

    let patch = json!({
        "foreshadowId": "fs-patch-cycle",
        "hypothesisId": "foreshadow-thread:patch-cycle",
        "baseVersion": 0,
        "intent": { "kind": "fill-if-empty", "value": "Recovered intent" },
        "mechanism": { "kind": "set-if-empty", "value": "echo-and-reveal" },
        "addSetups": [{
            "setupId": "su-cycle-2",
            "sceneId": "scene-2",
            "fromPos": 12,
            "toPos": 20,
            "role": "echo",
            "kind": "designated_existing",
            "aiStrength": "strong",
            "rationale": "The stopped watch appears again.",
            "semanticKey": "watch-echo"
        }],
        "addPayoffs": [{
            "payoffId": "po-cycle-0",
            "sceneId": "scene-3",
            "fromPos": 30,
            "toPos": 42,
            "role": "final",
            "confirmed": true,
            "primary": true,
            "rationale": "The watch establishes the time of death.",
            "semanticKey": "watch-reveal"
        }],
        "addSupportEdges": [{
            "setupId": "su-cycle-2",
            "payoffId": "po-cycle-0",
            "bridgeKind": "echo-reveal",
            "explanation": "The echo prepares the final reveal."
        }],
        "addCodexEntryIds": ["codex-watch"]
    });
    let patch_items = [("foreshadow.aggregate.patch", patch)];
    let patch_pairs = seed_approved_proposals(
        &db,
        "run-fs-patch-cycle",
        "set-fs-patch-cycle",
        &patch_items,
    );
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-patch-cycle",
            "digest-fs-patch-cycle",
            "set-fs-patch-cycle",
            "run-fs-patch-cycle",
            zip_ops(&patch_pairs, &patch_items),
        ),
    );
    let commit_id = applied["commitId"].as_str().expect("commit id");

    let undone =
        narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload(commit_id))
            .expect("undo aggregate patch");
    assert_eq!(undone["status"], "undone");
    db.with_conn(|conn| {
        let root: (Option<String>, Option<String>, Option<String>, i64) = conn.query_row(
            "SELECT intent, mechanism, payoff_scene_id, version
               FROM foreshadows WHERE id = 'fs-patch-cycle'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let counts: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_payoffs WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_codex_links WHERE foreshadow_id = 'fs-patch-cycle')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(root, (None, None, None, 2));
        assert_eq!(counts, (1, 1, 1, 0));
        Ok(())
    })
    .unwrap();

    let redone =
        narrative_extraction::narrative_extraction_redo_commit(&db, undo_payload(commit_id))
            .expect("redo aggregate patch");
    assert_eq!(redone["status"], "redone");
    db.with_conn(|conn| {
        let root: PatchReplayRootState = conn.query_row(
            "SELECT intent, mechanism, payoff_scene_id, payoff_from_pos, payoff_to_pos,
                    payoff_confirmed, version
               FROM foreshadows WHERE id = 'fs-patch-cycle'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )?;
        let counts: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
                (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_payoffs WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links WHERE foreshadow_id = 'fs-patch-cycle'),
                (SELECT COUNT(*) FROM foreshadow_codex_links WHERE foreshadow_id = 'fs-patch-cycle')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let child: (String, String, String, String) = conn.query_row(
            "SELECT setup.role, setup.semantic_key, payoff.semantic_key, edge.bridge_kind
               FROM foreshadow_setups setup
               JOIN foreshadow_setup_payoff_links edge ON edge.setup_id = setup.id
               JOIN foreshadow_payoffs payoff ON payoff.id = edge.payoff_id
              WHERE setup.id = 'su-cycle-2' AND payoff.id = 'po-cycle-0'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            root,
            (
                Some("Recovered intent".to_string()),
                Some("echo-and-reveal".to_string()),
                Some("scene-3".to_string()),
                Some(30),
                Some(42),
                1,
                3,
            )
        );
        assert_eq!(counts, (2, 2, 2, 1));
        assert_eq!(
            child,
            (
                "echo".to_string(),
                "watch-echo".to_string(),
                "watch-reveal".to_string(),
                "echo-reveal".to_string(),
            )
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn foreshadow_patch_child_edit_conflict_blocks_undo_without_partial_restore() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");

    let create_items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-child-conflict", "foreshadow-thread:child-conflict"),
    )];
    let create_pairs = seed_approved_proposals(
        &db,
        "run-fs-child-conflict-create",
        "set-fs-child-conflict-create",
        &create_items,
    );
    prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-child-conflict-create",
            "digest-fs-child-conflict-create",
            "set-fs-child-conflict-create",
            "run-fs-child-conflict-create",
            zip_ops(&create_pairs, &create_items),
        ),
    );

    let patch_items = [(
        "foreshadow.aggregate.patch",
        json!({
            "foreshadowId": "fs-child-conflict",
            "hypothesisId": "foreshadow-thread:child-conflict",
            "baseVersion": 0,
            "intent": { "kind": "leave" },
            "mechanism": { "kind": "leave" },
            "addSetups": [{
                "setupId": "su-child-conflict",
                "sceneId": "scene-2",
                "fromPos": 20,
                "toPos": 30,
                "role": "echo",
                "kind": "designated_existing"
            }],
            "addPayoffs": [],
            "addSupportEdges": [],
            "addCodexEntryIds": []
        }),
    )];
    let patch_pairs = seed_approved_proposals(
        &db,
        "run-fs-child-conflict",
        "set-fs-child-conflict",
        &patch_items,
    );
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-child-conflict",
            "digest-fs-child-conflict",
            "set-fs-child-conflict",
            "run-fs-child-conflict",
            zip_ops(&patch_pairs, &patch_items),
        ),
    );
    let commit_id = applied["commitId"].as_str().expect("commit id");

    db.execute(
        "UPDATE foreshadow_setups SET role = 'human-edit'
          WHERE id = 'su-child-conflict'",
        &[],
        "run",
    )
    .expect("tamper child without root version bump");

    let err = narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload(commit_id))
        .expect_err("child edit must block undo");
    assert!(err.to_string().contains("NEX_COMMIT_FORESHADOW_EDITED"));
    db.with_conn(|conn| {
        let state: (i64, String, i64, String) = conn.query_row(
            "SELECT root.version, setup.role,
                    (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = root.id),
                    commit_row.status
               FROM foreshadows root
               JOIN foreshadow_setups setup ON setup.id = 'su-child-conflict'
               JOIN narrative_apply_commits commit_row ON commit_row.id = ?1
              WHERE root.id = 'fs-child-conflict'",
            [commit_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(
            state,
            (1, "human-edit".to_string(), 2, "applied".to_string())
        );
        Ok(())
    })
    .unwrap();
}

#[test]
fn foreshadow_patch_redo_failure_rolls_back_root_and_all_children() {
    let db = migrated_db();
    seed_scene(&db, "scene-1", "Scene One");
    seed_scene(&db, "scene-2", "Scene Two");
    seed_scene(&db, "scene-3", "Scene Three");

    let create_items = [(
        "foreshadow.aggregate.create",
        aggregate_create("fs-redo-rollback", "foreshadow-thread:redo-rollback"),
    )];
    let create_pairs = seed_approved_proposals(
        &db,
        "run-fs-redo-rollback-create",
        "set-fs-redo-rollback-create",
        &create_items,
    );
    prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-redo-rollback-create",
            "digest-fs-redo-rollback-create",
            "set-fs-redo-rollback-create",
            "run-fs-redo-rollback-create",
            zip_ops(&create_pairs, &create_items),
        ),
    );

    let patch_items = [(
        "foreshadow.aggregate.patch",
        json!({
            "foreshadowId": "fs-redo-rollback",
            "hypothesisId": "foreshadow-thread:redo-rollback",
            "baseVersion": 0,
            "intent": { "kind": "leave" },
            "mechanism": { "kind": "leave" },
            "addSetups": [{
                "setupId": "su-redo-rollback",
                "sceneId": "scene-2",
                "fromPos": 20,
                "toPos": 30,
                "role": "echo",
                "kind": "designated_existing"
            }],
            "addPayoffs": [{
                "payoffId": "po-redo-rollback",
                "sceneId": "scene-3",
                "fromPos": 40,
                "toPos": 50,
                "role": "final",
                "confirmed": true,
                "primary": true
            }],
            "addSupportEdges": [{
                "setupId": "su-redo-rollback",
                "payoffId": "po-redo-rollback",
                "bridgeKind": "forced-failure"
            }],
            "addCodexEntryIds": []
        }),
    )];
    let patch_pairs = seed_approved_proposals(
        &db,
        "run-fs-redo-rollback",
        "set-fs-redo-rollback",
        &patch_items,
    );
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-fs-redo-rollback",
            "digest-fs-redo-rollback",
            "set-fs-redo-rollback",
            "run-fs-redo-rollback",
            zip_ops(&patch_pairs, &patch_items),
        ),
    );
    let commit_id = applied["commitId"].as_str().expect("commit id");
    narrative_extraction::narrative_extraction_undo_commit(&db, undo_payload(commit_id))
        .expect("undo patch before forced redo failure");

    db.execute(
        "CREATE TRIGGER fail_foreshadow_redo_edge
           BEFORE INSERT ON foreshadow_setup_payoff_links
           WHEN NEW.setup_id = 'su-redo-rollback'
         BEGIN
           SELECT RAISE(ABORT, 'forced foreshadow replay failure');
         END",
        &[],
        "run",
    )
    .expect("install failure trigger");

    let err = narrative_extraction::narrative_extraction_redo_commit(&db, undo_payload(commit_id))
        .expect_err("forced child insertion failure must abort redo");
    assert!(err.to_string().contains("forced foreshadow replay failure"));
    db.with_conn(|conn| {
        let state: (i64, i64, i64, i64, String) = conn.query_row(
            "SELECT root.version,
                    (SELECT COUNT(*) FROM foreshadow_setups WHERE foreshadow_id = root.id),
                    (SELECT COUNT(*) FROM foreshadow_payoffs WHERE foreshadow_id = root.id),
                    (SELECT COUNT(*) FROM foreshadow_setup_payoff_links WHERE foreshadow_id = root.id),
                    commit_row.status
               FROM foreshadows root
               JOIN narrative_apply_commits commit_row ON commit_row.id = ?1
              WHERE root.id = 'fs-redo-rollback'",
            [commit_id],
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
        assert_eq!(state, (2, 1, 1, 1, "undone".to_string()));
        Ok(())
    })
    .unwrap();
}
