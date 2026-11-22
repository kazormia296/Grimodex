#[path = "../test-support/snapshot_restore.rs"]
mod snapshot_restore;
#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_db::domain_writes::{
    project_create, tree_node_create, ProjectCreatePayload, TreeNodeCreatePayload,
};
use grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin;
use grimodex_db::narrative_extraction::{
    self, run_incremental_freshness_cycle, write_dependency_declaration_set, AppendDecisionPayload,
    ApplyCommitPayload, CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    DependencyDeclaration, DependencyDeclarationSetRequest, IncrementalFreshnessCycleOutcome,
    PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload, UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use serde_json::{json, Value};

fn migrated_db() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    project_create(
        &db,
        ProjectCreatePayload {
            project_id: "project-1".to_string(),
            request_id: "fixture-project-1".to_string(),
            session_id: "fixture-session".to_string(),
            event_uid: "fixture-project-1-event".to_string(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            title: "Project".to_string(),
            genre: None,
            pov: None,
            tense: None,
            language: None,
            style_guide: None,
            ai_instructions: None,
            outline: None,
            target_readers: None,
            created_at: "2026-08-24T00:00:00.000Z".to_string(),
            updated_at: "2026-08-24T00:00:00.000Z".to_string(),
            scene_scope_default: None,
        },
    )
    .expect("seed project through production writer");
    remove_setup_feed_transaction(&db, "fixture-project-1");
    db
}

fn remove_setup_feed_transaction(db: &Database, request_id: &str) {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_change_events
              WHERE project_id = 'project-1'
                AND transaction_id IN (
                    SELECT id FROM narrative_change_transactions
                     WHERE project_id = 'project-1' AND request_id = ?1
                )",
            [request_id],
        )?;
        conn.execute(
            "DELETE FROM narrative_change_transactions
              WHERE project_id = 'project-1' AND request_id = ?1",
            [request_id],
        )?;
        Ok::<_, anyhow::Error>(())
    })
    .expect("remove setup Feed transaction");
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
    tree_node_create(
        db,
        TreeNodeCreatePayload {
            id: scene_id.to_string(),
            project_id: "project-1".to_string(),
            request_id: format!("fixture-scene-{scene_id}"),
            session_id: "fixture-session".to_string(),
            event_uid: format!("fixture-scene-{scene_id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: None,
            node_type: "scene".to_string(),
            title: title.to_string(),
            sort_order: "a0".to_string(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: None,
            canonical_payload: None,
        },
    )
    .expect("seed scene through production writer");
    remove_setup_feed_transaction(db, &format!("fixture-scene-{scene_id}"));
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
fn scene_chronicle_journal_root_does_not_select_project_scope_authority() {
    let db = migrated_db();
    seed_scene(&db, "scene-scope-calendar", "Chronicle-only Scene");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-scope-calendar', 'project-1', 0, 'initial',
                     '2026-08-24T00:00:00.000Z')",
            [],
        )?;
        Ok(())
    })
    .expect("seed canonical Epoch authority for the Feed cycle");
    let items = [(
        "temporal.scene.metadata.patch",
        json!({
            "sceneId": "scene-scope-calendar",
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
    let pairs = seed_approved_proposals(&db, "run-scope-calendar", "set-scope-calendar", &items);
    write_dependency_declaration_set(
        &db,
        DependencyDeclarationSetRequest {
            project_id: "project-1".to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: "scope-calendar-consumer".to_owned(),
            producer_id: "proposal-revision-source-basis".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: "project:scope-authority:project-1".to_owned(),
                role: DependencyRole::ScopeResolution,
                selector: DependencySelector::WholeSource,
            }],
            created_at: "2026-08-24T00:00:00.000Z".to_owned(),
        },
    )
    .expect("seal the project Scope declaration before the Chronicle-only commit");

    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-scope-calendar",
            "digest-scope-calendar",
            "set-scope-calendar",
            "run-scope-calendar",
            zip_ops(&pairs, &items),
        ),
    );
    let journal_id = applied["journalId"].as_str().expect("journal id");
    let transaction_id = applied["maintenanceTransactionId"]
        .as_str()
        .expect("maintenance transaction id");
    db.with_conn(|conn| {
        let entity_kind: String = conn.query_row(
            "SELECT json_extract(after_json, '$.entities[0].entityKind')
               FROM narrative_commit_journals WHERE id = ?1",
            [journal_id],
            |row| row.get(0),
        )?;
        assert_eq!(entity_kind, "temporal_scene_chronicle");
        let (object_kind, change_kind, mutation_kind, changed_paths): (
            String,
            String,
            String,
            String,
        ) = conn.query_row(
            "SELECT json_extract(object_key_json, '$.kind'), change_kind,
                    mutation_kind, changed_paths_json
               FROM narrative_change_events
              WHERE transaction_id = ?1
                AND json_extract(object_key_json, '$.kind') = 'scene'",
            [transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(object_kind, "scene");
        assert_eq!(change_kind, "calendar");
        assert_eq!(mutation_kind, "update");
        assert_eq!(changed_paths, r#"["/"]"#);
        Ok::<_, anyhow::Error>(())
    })
    .expect("verify the real journal-to-Feed projection");

    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(&db).expect("process the Chronicle-only Feed event")
    else {
        panic!("the Chronicle commit must leave a pending Feed range");
    };
    // X1-2: a Chronicle-range patch is not a Scope field. It no longer
    // refreshes the Scene's Scope binding, so neither the journal root (above)
    // nor a `scene-scope` event selects the project Scope authority.
    assert_eq!(summary.v2_shadow.evaluated_declaration_count, 0);
    assert!(summary.v2_shadow.consumers.is_empty());
    assert_eq!(scene_scope_binding_version(&db, "scene-scope-calendar"), 1);
    assert_eq!(
        scope_event_count_in_transaction(&db, transaction_id),
        0,
        "a Chronicle-only commit appends no scene-scope event"
    );
}

fn scene_scope_binding_version(db: &Database, scene_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT version FROM narrative_scene_scope_bindings
              WHERE project_id = 'project-1' AND scene_id = ?1",
            [scene_id],
            |row| row.get(0),
        )?)
    })
    .expect("Scene Scope binding version")
}

fn scope_event_count_in_transaction(db: &Database, transaction_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_events
              WHERE transaction_id = ?1
                AND json_extract(object_key_json, '$.kind') = 'scene-scope'",
            [transaction_id],
            |row| row.get(0),
        )?)
    })
    .expect("scene-scope event count")
}

fn latest_transaction_id(db: &Database) -> String {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_change_transactions
              WHERE project_id = 'project-1'
              ORDER BY source_change_event_sequence DESC LIMIT 1",
            [],
            |row| row.get(0),
        )?)
    })
    .expect("latest Feed transaction")
}

fn undo_commit(db: &Database, commit_id: &str, request_id: &str) -> Value {
    narrative_extraction::narrative_extraction_undo_commit(
        db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-temporal".to_string(),
            surface: None,
            commit_id: Some(commit_id.to_string()),
            request_id: Some(request_id.to_string()),
        },
    )
    .expect("undo")
}

fn seed_scene_body_consumer(db: &Database, scene_id: &str) {
    write_dependency_declaration_set(
        db,
        DependencyDeclarationSetRequest {
            project_id: "project-1".to_owned(),
            consumer_kind: "proposal-revision".to_owned(),
            consumer_key: format!("body-consumer-{scene_id}"),
            producer_id: "proposal-revision-source-basis".to_owned(),
            producer_generation: 1,
            expected_head_version: 0,
            declarations: vec![DependencyDeclaration {
                source_object_identity: format!("project:scene:{scene_id}"),
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            }],
            created_at: "2026-08-24T00:00:00.000Z".to_owned(),
        },
    )
    .expect("seal a whole-Source declaration for the Scene body Source");
}

fn processed_cycle(
    db: &Database,
) -> grimodex_db::narrative_extraction::IncrementalFreshnessBatchSummary {
    let IncrementalFreshnessCycleOutcome::Processed(summary) =
        run_incremental_freshness_cycle(db).expect("process the Feed range")
    else {
        panic!("the commit must leave a pending Feed range");
    };
    summary
}

fn chronicle_patch_item(scene_id: &str, base_version: i64) -> (&'static str, Value) {
    (
        "temporal.scene.metadata.patch",
        json!({
            "sceneId": scene_id,
            "baseVersion": base_version,
            "startTime": 5,
            "startMinute": 480,
            "startGranularity": "time",
            "endTime": 5,
            "endMinute": 540,
            "endGranularity": "time",
            "precision": "exact",
        }),
    )
}

fn materialize_item(
    scene_id: &str,
    base_version: i64,
    order: &str,
    label: &str,
) -> (&'static str, Value) {
    (
        "temporal.story-order.materialize",
        json!({
            "sceneId": scene_id,
            "baseVersion": base_version,
            "storyTimeOrder": order,
            "storyTimeLabel": label,
        }),
    )
}

fn apply_items(db: &Database, tag: &str, items: &[(&str, Value)]) -> Value {
    let run_id = format!("run-{tag}");
    let set_id = format!("set-{tag}");
    let pairs = seed_approved_proposals(db, &run_id, &set_id, items);
    prepare_and_apply(
        db,
        build_prepare(
            &format!("req-{tag}"),
            &format!("digest-{tag}"),
            &set_id,
            &run_id,
            zip_ops(&pairs, items),
        ),
    )
}

/// X1-2. The Chronicle-range patch commit and its undo no longer refresh the
/// Scene's Scope binding, yet the Scene body Source still reaches its
/// dependents through the `scene` Feed event identity alone (neither writer
/// calls `propagate_source_change_freshness_in_tx`).
#[test]
fn chronicle_commit_and_undo_reach_the_scene_body_source_without_a_scope_refresh() {
    let db = migrated_db();
    seed_scene(&db, "scene-chronicle-reach", "Chronicle reach");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-reach', 'project-1', 0, 'initial', '2026-08-24T00:00:00.000Z')",
            [],
        )?;
        Ok(())
    })
    .expect("seed canonical Epoch authority for the Feed cycle");
    seed_scene_body_consumer(&db, "scene-chronicle-reach");
    let before_token: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT 'v' || version || '@' || updated_at FROM tree_nodes
                  WHERE id = 'scene-chronicle-reach'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("body Source token");

    let applied = apply_items(
        &db,
        "chronicle-reach",
        &[chronicle_patch_item("scene-chronicle-reach", 0)],
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();
    let after_token: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT 'v' || version || '@' || updated_at FROM tree_nodes
                  WHERE id = 'scene-chronicle-reach'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("body Source token after the patch");
    assert_ne!(
        before_token, after_token,
        "the patch advances the body token"
    );
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        0
    );
    let forward = processed_cycle(&db);
    assert_eq!(forward.v2_shadow.evaluated_declaration_count, 1);
    assert_eq!(forward.v2_shadow.consumers[0].freshness, "stale");

    undo_commit(&db, &commit_id, "chronicle-reach-undo");
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        0
    );
    let undone = processed_cycle(&db);
    assert_eq!(
        undone.v2_shadow.evaluated_declaration_count, 1,
        "the undo's `scene` event alone selects the body-Source declaration"
    );
    assert_eq!(scene_scope_binding_version(&db, "scene-chronicle-reach"), 1);
}

/// X1-2. A story-order materialize and its undo advance the Scene's Scope
/// generation only when `storyTimeOrder` itself changes; a label-only change
/// moves the body Source token alone, and every step still reaches the body
/// Source consumer through the `scene` Feed event.
#[test]
fn story_order_materialize_and_undo_refresh_the_scope_only_when_the_order_changes() {
    let db = migrated_db();
    seed_scene(&db, "scene-order", "Order");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_semantic_epochs
                (id, project_id, epoch_number, reason, created_at)
             VALUES ('epoch-order', 'project-1', 0, 'initial', '2026-08-24T00:00:00.000Z')",
            [],
        )?;
        Ok(())
    })
    .expect("seed canonical Epoch authority for the Feed cycle");
    seed_scene_body_consumer(&db, "scene-order");
    assert_eq!(scene_scope_binding_version(&db, "scene-order"), 1);

    // NULL -> a0 changes the order.
    apply_items(
        &db,
        "order-1",
        &[materialize_item("scene-order", 0, "a0", "label one")],
    );
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        1
    );
    assert_eq!(scene_scope_binding_version(&db, "scene-order"), 2);
    assert_eq!(
        processed_cycle(&db).v2_shadow.evaluated_declaration_count,
        1
    );

    // a0 -> a0 with a new label leaves the order, hence the generation.
    let second = apply_items(
        &db,
        "order-2",
        &[materialize_item("scene-order", 1, "a0", "label two")],
    );
    let second_commit = second["commitId"].as_str().unwrap().to_string();
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        0,
        "a label-only materialize appends no scene-scope event"
    );
    assert_eq!(scene_scope_binding_version(&db, "scene-order"), 2);
    assert_eq!(
        processed_cycle(&db).v2_shadow.evaluated_declaration_count,
        1,
        "the label-only materialize still reaches the body Source consumer"
    );

    // Undoing the label-only step restores the same order: no refresh.
    undo_commit(&db, &second_commit, "order-2-undo");
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        0
    );
    assert_eq!(scene_scope_binding_version(&db, "scene-order"), 2);
    assert_eq!(
        processed_cycle(&db).v2_shadow.evaluated_declaration_count,
        1
    );

    // A separate Scene: materialize NULL -> a0, then undo back to NULL.
    seed_scene(&db, "scene-order-undo", "Order undo");
    seed_scene_body_consumer(&db, "scene-order-undo");
    let third = apply_items(
        &db,
        "order-3",
        &[materialize_item("scene-order-undo", 0, "b0", "label")],
    );
    let third_commit = third["commitId"].as_str().unwrap().to_string();
    assert_eq!(scene_scope_binding_version(&db, "scene-order-undo"), 2);
    processed_cycle(&db);
    // Undoing restores the NULL order: the generation advances again.
    undo_commit(&db, &third_commit, "order-3-undo");
    assert_eq!(
        scope_event_count_in_transaction(&db, &latest_transaction_id(&db)),
        1
    );
    assert_eq!(scene_scope_binding_version(&db, "scene-order-undo"), 3);
    assert_eq!(
        processed_cycle(&db).v2_shadow.evaluated_declaration_count,
        1
    );
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

    let before_binding: (i64, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT version, source_token
                   FROM narrative_scene_scope_bindings
                  WHERE project_id = 'project-1' AND scene_id = 'scene-2'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })
        .expect("read pre-failure scope binding");

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
        let after_binding: (i64, String) = conn.query_row(
            "SELECT version, source_token
               FROM narrative_scene_scope_bindings
              WHERE project_id = 'project-1' AND scene_id = 'scene-2'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let commit_feed_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = 'project-1' AND request_id = 'req-rollback-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(node_count, 0, "node.ensure must roll back with the rest");
        assert_eq!(constraint_count, 0);
        assert_eq!(scene_start, None, "scene patch must roll back");
        assert_eq!(scene_version, 0);
        assert_eq!(event_version, 0);
        assert_eq!(after_binding, before_binding);
        assert_eq!(
            commit_feed_count, 0,
            "failed apply must not append Feed rows"
        );
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
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = 'project-1'
                AND request_id IN ('req-existing-a', 'req-existing-b')",
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

// --- 場面・出来事の Chronicle patch の commit と、スナップショットの復元（確認 88 の条件） ---
//
// Body の復元は、場面（tree_nodes）の版を 0 に戻し、出来事（events）の版をスナップショットの
// 版に戻す。取り込みの専用の守り（undo.rs の preflight）は、この 2 種類を版だけで比べる。
// 復元の後の編集で版が commit の版と偶然一致しても、取り消しが復元の後の編集を巻き戻さない
// ことを、実際の復元を通して確かめる。守りは変更の記録の連続性の検査（head 経由）。

mod commit_undo_after_restore {
    use super::*;
    use grimodex_db::agent_writes::{agent_event_update_impl, AgentEventUpdatePayload};
    use grimodex_db::domain_writes::{tree_node_patch, TreeNodePatchPayload};
    use grimodex_db::project_snapshots::RestoreScope;

    const RESTORE_SESSION: &str = "sess-restore";

    fn restore_body(db: &Database, request_id: &str, snapshot_id: &str) {
        let no_op = snapshot_restore::restore(
            db,
            "project-1",
            RESTORE_SESSION,
            request_id,
            snapshot_id,
            vec![RestoreScope::Body],
        )
        .expect("restore the snapshot");
        assert!(!no_op, "the restore must change rows and write its marker");
    }

    fn assert_superseded_by_restore(result: anyhow::Result<Value>, what: &str) {
        let error = result.expect_err(what);
        let message = format!("{error:#}");
        assert!(
            message.contains("NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE"),
            "{what}: expected NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE, got {message}"
        );
    }

    fn assert_feed_discontinuity(result: anyhow::Result<Value>, what: &str) {
        let error = result.expect_err(what);
        let message = format!("{error:#}");
        assert!(
            message.contains("NARRATIVE_CHANGE_FEED_DISCONTINUITY"),
            "{what}: expected NARRATIVE_CHANGE_FEED_DISCONTINUITY, got {message}"
        );
    }

    fn undo_result(db: &Database, commit_id: &str, request_id: &str) -> anyhow::Result<Value> {
        narrative_extraction::narrative_extraction_undo_commit(
            db,
            UndoCommitPayload {
                project_id: "project-1".to_string(),
                session_id: "sess-temporal".to_string(),
                surface: None,
                commit_id: Some(commit_id.to_string()),
                request_id: Some(request_id.to_string()),
            },
        )
    }

    fn scene_state(db: &Database, id: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title || '|' || COALESCE(chronicle_start_time, -1) || '|v' || version
                   FROM tree_nodes WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("scene state")
    }

    fn event_state(db: &Database, id: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title || '|' || COALESCE(start_time, -1) || '|v' || version
                   FROM events WHERE id = ?1",
                [id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("event state")
    }

    /// (a) 場面の Chronicle patch の commit（版 0 → 1）。スナップショットは commit の前（版 0）。
    /// Body の復元（版 0）→ 復元の後の編集（版 1 = commit の版と一致）→ 取り消し。
    /// 専用の守り（版だけ）は通るが、連続性の検査が止め、編集は残る。
    #[test]
    fn undo_of_a_scene_chronicle_patch_after_a_body_restore_and_a_later_edit_is_stopped_by_the_feed(
    ) {
        let db = migrated_db();
        seed_scene(&db, "scene-rs", "Scene RS");
        snapshot_restore::seed_restore_prerequisites(&db, "project-1", RESTORE_SESSION);
        snapshot_restore::snapshot(&db, "project-1", "snap-rs");

        let applied = apply_items(&db, "rs-scene", &[chronicle_patch_item("scene-rs", 0)]);
        let commit = applied["commitId"].as_str().unwrap().to_string();
        assert_eq!(scene_state(&db, "scene-rs"), "Scene RS|5|v1");

        restore_body(&db, "restore-rs", "snap-rs");
        assert_eq!(scene_state(&db, "scene-rs"), "Scene RS|-1|v0");

        tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "project-1".to_string(),
                request_id: "author-after-restore-scene".to_string(),
                session_id: "sess-author".to_string(),
                event_uid: "uid-author-after-restore-scene".to_string(),
                node_id: "scene-rs".to_string(),
                patch: json!({ "title": "AUTHOR AFTER RESTORE" })
                    .as_object()
                    .expect("patch")
                    .clone(),
                base_version: Some(0),
                bump_version: true,
                updated_at: "2026-11-22T00:00:00.000Z".to_string(),
                change_event: None,
                timelapse_doc_step_coverage: None,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                source_domain: None,
                op_type: None,
                canonical_payload: None,
            },
        )
        .expect("author edits the scene after the restore");
        assert_eq!(scene_state(&db, "scene-rs"), "AUTHOR AFTER RESTORE|-1|v1");

        assert_feed_discontinuity(
            undo_result(&db, &commit, "rs-scene-undo"),
            "undo after the Body restore and a later scene edit",
        );
        assert_eq!(scene_state(&db, "scene-rs"), "AUTHOR AFTER RESTORE|-1|v1");
    }

    /// (b) 出来事の Chronicle patch の commit（版 0 → 1）。スナップショットは commit の前（版 0）。
    /// Body の復元（版 0）→ 復元の後の編集（版 1 = commit の版と一致）→ 取り消し。
    /// 出来事の版は、復元の後に作者が書いていなくても一致し得る（復元は枝を作れる。下の試験）
    /// ので、確認 88 の点検の後は、確かめた種類から外した。復元の後の取り消しは、復元の marker
    /// より古い commit の replay として拒まれる。復元の後の編集は残る。
    #[test]
    fn undo_of_an_event_chronicle_patch_after_a_body_restore_and_a_later_edit_is_refused_and_the_edit_stays(
    ) {
        let db = migrated_db();
        seed_event(&db, "event-rs", "Event RS");
        snapshot_restore::seed_restore_prerequisites(&db, "project-1", RESTORE_SESSION);
        snapshot_restore::snapshot(&db, "project-1", "snap-rse");

        let applied = apply_items(
            &db,
            "rs-event",
            &[(
                "temporal.event.metadata.patch",
                json!({
                    "eventId": "event-rs",
                    "baseVersion": 0,
                    "startTime": 5,
                    "startMinute": 480,
                    "startGranularity": "time",
                    "endTime": 5,
                    "endMinute": 500,
                    "endGranularity": "time",
                    "precision": "exact",
                }),
            )],
        );
        let commit = applied["commitId"].as_str().unwrap().to_string();
        assert_eq!(event_state(&db, "event-rs"), "Event RS|5|v1");

        restore_body(&db, "restore-rse", "snap-rse");
        assert_eq!(event_state(&db, "event-rs"), "Event RS|-1|v0");

        agent_event_update_impl(
            &db,
            serde_json::from_value::<AgentEventUpdatePayload>(json!({
                "projectId": "project-1", "sessionId": "sess-author", "surface": "manual",
                "eventId": "event-rs", "baseVersion": 0, "title": "AUTHOR AFTER RESTORE"
            }))
            .expect("update payload"),
        )
        .expect("author edits the event after the restore");
        assert_eq!(event_state(&db, "event-rs"), "AUTHOR AFTER RESTORE|-1|v1");

        assert_superseded_by_restore(
            undo_result(&db, &commit, "rs-event-undo"),
            "undo after the Body restore and a later event edit",
        );
        assert_eq!(event_state(&db, "event-rs"), "AUTHOR AFTER RESTORE|-1|v1");
    }
    // --- 復元の後に作者が書いていない object で、版が取り込みの時と一致する筋書き（確認 88 の点検） ---
    //
    // 場面（tree_nodes）の版は、復元で 0 に戻る（復元の行に版が無い）。取り込みの patch は版を
    // 0 以上から 1 以上へ進めるので、復元の直後の場面の版は取り込んだ時の版と一致しない。
    // 出来事（events）の版は、スナップショットの版のまま戻る。復元は枝を作れる（S0 へ戻して
    // 取り込み、別の枝の S1 へ戻す）ので、版は一致し得る。どちらの種類も、復元の後に誰も書いて
    // いない object の取り消しが、復元の後の状態を黙って取り込みの前へ巻き戻してはならない。

    /// 場面：復元の直後（作者は書いていない）は、版が 0 で取り込んだ時の版（1）と一致せず、拒まれる。
    /// 別の枝を経由しても、場面の版は 0 に戻るので、一致しない。
    #[test]
    fn undo_of_a_scene_chronicle_patch_right_after_body_restores_is_refused_and_keeps_the_restored_scene(
    ) {
        let db = migrated_db();
        seed_scene(&db, "scene-ru", "Scene RU");
        snapshot_restore::seed_restore_prerequisites(&db, "project-1", RESTORE_SESSION);
        snapshot_restore::snapshot(&db, "project-1", "snap-ru0");
        tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "project-1".to_string(),
                request_id: "author-branch-scene".to_string(),
                session_id: "sess-author".to_string(),
                event_uid: "uid-author-branch-scene".to_string(),
                node_id: "scene-ru".to_string(),
                patch: json!({ "title": "BRANCH" })
                    .as_object()
                    .expect("patch")
                    .clone(),
                base_version: Some(0),
                bump_version: true,
                updated_at: "2026-11-22T00:00:00.000Z".to_string(),
                change_event: None,
                timelapse_doc_step_coverage: None,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                source_domain: None,
                op_type: None,
                canonical_payload: None,
            },
        )
        .expect("author edits the scene on a branch");
        snapshot_restore::snapshot(&db, "project-1", "snap-ru1");
        restore_body(&db, "restore-ru0", "snap-ru0");
        assert_eq!(scene_state(&db, "scene-ru"), "Scene RU|-1|v0");

        let applied = apply_items(&db, "ru-scene", &[chronicle_patch_item("scene-ru", 0)]);
        let commit = applied["commitId"].as_str().unwrap().to_string();
        assert_eq!(scene_state(&db, "scene-ru"), "Scene RU|5|v1");
        restore_body(&db, "restore-ru1", "snap-ru1");
        assert_eq!(scene_state(&db, "scene-ru"), "BRANCH|-1|v0");

        let error = undo_result(&db, &commit, "ru-scene-undo").expect_err("undo is refused");
        let message = format!("{error:#}");
        assert!(
            message.contains("NEX_COMMIT_SCENE_EDITED")
                || message.contains("NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE"),
            "unexpected refusal: {message}"
        );
        assert_eq!(scene_state(&db, "scene-ru"), "BRANCH|-1|v0");
    }

    /// 出来事：S0（版 0）→ 作者が編集（版 1、BRANCH）→ S1 を取る → S0 へ復元 → 取り込みの
    /// patch（版 1）→ S1 へ復元（版 1、BRANCH）。復元の後は誰も書いておらず、版は取り込んだ時の
    /// 版と一致する。取り消しが通れば、復元の後の題（BRANCH）を黙って取り込みの前の状態へ戻す。
    #[test]
    fn undo_of_an_event_chronicle_patch_after_restores_that_branch_must_not_roll_back_the_restored_event(
    ) {
        let db = migrated_db();
        seed_event(&db, "event-ru", "Event RU");
        snapshot_restore::seed_restore_prerequisites(&db, "project-1", RESTORE_SESSION);
        snapshot_restore::snapshot(&db, "project-1", "snap-rue0");
        agent_event_update_impl(
            &db,
            serde_json::from_value::<AgentEventUpdatePayload>(json!({
                "projectId": "project-1", "sessionId": "sess-author", "surface": "manual",
                "eventId": "event-ru", "baseVersion": 0, "title": "BRANCH"
            }))
            .expect("update payload"),
        )
        .expect("author edits the event on a branch");
        assert_eq!(event_state(&db, "event-ru"), "BRANCH|-1|v1");
        snapshot_restore::snapshot(&db, "project-1", "snap-rue1");
        restore_body(&db, "restore-rue0", "snap-rue0");
        assert_eq!(event_state(&db, "event-ru"), "Event RU|-1|v0");

        let applied = apply_items(
            &db,
            "ru-event",
            &[(
                "temporal.event.metadata.patch",
                json!({
                    "eventId": "event-ru",
                    "baseVersion": 0,
                    "startTime": 5,
                    "startMinute": 480,
                    "startGranularity": "time",
                    "endTime": 5,
                    "endMinute": 500,
                    "endGranularity": "time",
                    "precision": "exact",
                }),
            )],
        );
        let commit = applied["commitId"].as_str().unwrap().to_string();
        assert_eq!(event_state(&db, "event-ru"), "Event RU|5|v1");
        restore_body(&db, "restore-rue1", "snap-rue1");
        assert_eq!(event_state(&db, "event-ru"), "BRANCH|-1|v1");

        assert_superseded_by_restore(
            undo_result(&db, &commit, "ru-event-undo"),
            "undo of the event patch after a restore that put a different event at the same version",
        );
        assert_eq!(event_state(&db, "event-ru"), "BRANCH|-1|v1");
    }

    /// 復元の後の最初の書き込みが取り込み（commit）でも通り、2 回目の commit も通る。
    #[test]
    fn a_commit_as_the_first_write_after_a_body_restore_succeeds_twice() {
        let db = migrated_db();
        seed_scene(&db, "scene-rf", "Scene RF");
        snapshot_restore::seed_restore_prerequisites(&db, "project-1", RESTORE_SESSION);
        snapshot_restore::snapshot(&db, "project-1", "snap-rf");

        apply_items(&db, "rf-1", &[chronicle_patch_item("scene-rf", 0)]);
        assert_eq!(scene_state(&db, "scene-rf"), "Scene RF|5|v1");
        restore_body(&db, "restore-rf", "snap-rf");
        assert_eq!(scene_state(&db, "scene-rf"), "Scene RF|-1|v0");

        let first = apply_items(&db, "rf-2", &[chronicle_patch_item("scene-rf", 0)]);
        assert_eq!(first["status"], "applied");
        assert_eq!(scene_state(&db, "scene-rf"), "Scene RF|5|v1");
        let second = apply_items(
            &db,
            "rf-3",
            &[(
                "temporal.scene.metadata.patch",
                json!({
                    "sceneId": "scene-rf",
                    "baseVersion": 1,
                    "startTime": 6,
                    "startMinute": 0,
                    "startGranularity": "time",
                    "endTime": 6,
                    "endMinute": 30,
                    "endGranularity": "time",
                    "precision": "exact",
                }),
            )],
        );
        assert_eq!(second["status"], "applied");
        assert_eq!(scene_state(&db, "scene-rf"), "Scene RF|6|v2");
    }
}

// --- 復元の後の取り消し・やり直し（DR-SRC-12。確かめていない種類は拒んだまま） ---
//
// 時間の node・constraint の commit は、確認 88 の条件（専用の守りで、復元の後の編集が
// 巻き戻らないことを、試験で確かめる）を満たしていない種類である。復元の marker の後は、
// 取り消しは NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE で拒まれ、何も変わらない
// （やり直しは、この種類では元から未対応）。

mod unverified_commit_after_restore {
    use super::*;

    /// Redo of a temporal node or constraint commit is not supported at all
    /// (`unsupported journal entity kind 'temporal_node'`), so only the undo is
    /// exercised here.
    fn undo(db: &Database, commit_id: &str, request_id: &str) -> anyhow::Result<Value> {
        narrative_extraction::narrative_extraction_undo_commit(
            db,
            UndoCommitPayload {
                project_id: "project-1".to_string(),
                session_id: "sess-temporal".to_string(),
                surface: None,
                commit_id: Some(commit_id.to_string()),
                request_id: Some(request_id.to_string()),
            },
        )
    }

    fn assert_superseded_by_restore(result: anyhow::Result<Value>, what: &str) {
        let error = result.expect_err(what);
        let message = format!("{error:#}");
        assert!(
            message.contains("NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE"),
            "{what}: expected NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE, got {message}"
        );
    }

    fn constraint_rows(db: &Database) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_temporal_constraints",
                [],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("count constraints")
    }

    fn node_rows(db: &Database, node_id: &str) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM narrative_temporal_nodes WHERE id = ?1",
                [node_id],
                |row| row.get::<_, i64>(0),
            )?)
        })
        .expect("count nodes")
    }

    fn commit_status(db: &Database, commit_id: &str) -> String {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM narrative_apply_commits WHERE id = ?1",
                [commit_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("commit status")
    }

    /// A commit that ensures a Scene node and adds a duration constraint to it.
    fn apply_node_and_constraint(db: &Database, tag: &str, scene_id: &str) -> String {
        let node_id = format!("tn:scene:{scene_id}");
        let applied = apply_items(
            db,
            tag,
            &[
                (
                    "temporal.node.ensure",
                    node_ensure_payload(
                        &node_id,
                        json!({ "kind": "scene", "documentRef": scene_id }),
                    ),
                ),
                (
                    "temporal.constraint.create",
                    json!({
                        "kind": "duration",
                        "nodeId": node_id,
                        "duration": { "min": 10, "max": 20, "unit": "minute" },
                        "authority": "model-inferred",
                        "strictness": "soft",
                        "sourceIds": [],
                    }),
                ),
            ],
        );
        assert_eq!(applied["status"], "applied");
        applied["commitId"].as_str().unwrap().to_string()
    }

    #[test]
    fn undo_of_a_node_and_constraint_commit_after_a_restore_is_refused_and_changes_nothing() {
        let db = migrated_db();
        seed_scene(&db, "scene-ta", "Scene TA");
        seed_scene(&db, "scene-tb", "Scene TB");
        let undone_before = apply_node_and_constraint(&db, "ta", "scene-ta");
        let applied_before = apply_node_and_constraint(&db, "tb", "scene-tb");
        // Without a restore, undo works: the refusals below are the restore's doing.
        let undone = undo(&db, &undone_before, "ta-undo").expect("undo before the restore");
        assert_eq!(undone["status"], "undone");
        assert_eq!(node_rows(&db, "tn:scene:scene-ta"), 0);

        snapshot_restore::restore_a_codex_entry_after_snapshot(
            &db,
            "project-1",
            "sess-restore",
            "t",
        );

        assert_superseded_by_restore(
            undo(&db, &applied_before, "tb-undo"),
            "undo of a node and constraint commit after the restore",
        );
        // Nothing changed: B's node and its one constraint stay, A stays undone.
        assert_eq!(node_rows(&db, "tn:scene:scene-tb"), 1);
        assert_eq!(constraint_rows(&db), 1);
        assert_eq!(node_rows(&db, "tn:scene:scene-ta"), 0);
        assert_eq!(commit_status(&db, &applied_before), "applied");
        assert_eq!(commit_status(&db, &undone_before), "undone");
    }
}
