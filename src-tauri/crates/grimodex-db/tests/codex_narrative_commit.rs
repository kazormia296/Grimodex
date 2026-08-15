use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload, CommitApplicationRef,
    CommitOperation, CreateRunPayload, CreateTaskSeed, EntityBindingSeed, GetCommitStatusPayload,
    ListResumableRunsPayload, PrepareCommitPayload, ProposalSeed, ReviseAndDecidePayload,
    RunRefPayload, SaveProposalSetPayload, UndoCommitPayload,
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
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "test.reconciler",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "narrative.test",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{"sourceKind":"snapshot-document","sourceKey":source_key,"revisionToken":"revision-1"}],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
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
            surface_path_id: "codex.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "codex" }),
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
            proposal_id: Some(format!("{proposal_set_id}-prop-{index}")),
            proposal_key: format!("{proposal_set_id}-key-{index}"),
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
            set_kind: "codex.extract.review@1".to_string(),
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

fn entry_create(entry_id: &str, name: &str, narrative_entity_id: &str) -> Value {
    json!({
        "entryId": entry_id,
        "typeSlug": "character",
        "name": name,
        "summary": null,
        "aliases": [],
        "parentId": null,
        "content": "{\"type\":\"doc\",\"content\":[]}",
        "narrativeEntityId": narrative_entity_id
    })
}

fn relation_create(
    relation_id: &str,
    subject: &str,
    object: &str,
    semantic_key: Option<&str>,
) -> Value {
    let mut payload = json!({
        "relationId": relation_id,
        "subjectEntityId": subject,
        "objectEntityId": object,
        "relationType": "friend",
        "directionality": "symmetric",
        "forwardLabel": "友人",
        "inverseLabel": "友人"
    });
    if let Some(key) = semantic_key {
        payload["semanticKey"] = Value::String(key.to_string());
    }
    payload
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
    entity_bindings: Vec<EntityBindingSeed>,
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
        session_id: "sess-codex".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings,
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

fn codex_review_envelope(review_payload: Value, kind: &str, operation_payload: Value) -> Value {
    json!({
        "version": 1,
        "reviewPayload": review_payload,
        "compiledOperation": {
            "kind": kind,
            "payload": operation_payload
        }
    })
}

fn seed_single_codex_proposal(
    db: &Database,
    run_id: &str,
    proposal_set_id: &str,
    proposal_id: &str,
    kind: &str,
    payload: Value,
) -> (String, String) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "codex.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "codex" }),
            spec_digest: format!("spec-{run_id}"),
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

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(proposal_set_id.to_string()),
            set_kind: "codex.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("{proposal_id}-key"),
                kind: kind.to_string(),
                payload_json: payload,
                reconciliation_envelope: Some(test_envelope(run_id, &format!("{run_id}-task"))),
            }],
        },
    )
    .expect("save proposal set");

    let proposal = &saved["proposals"][0];
    (
        proposal["proposalId"].as_str().unwrap().to_string(),
        proposal["revisionId"].as_str().unwrap().to_string(),
    )
}

fn ops_from_pairs(
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
fn two_entries_and_relation_atomic_commit() {
    let db = migrated_db();
    let items = [
        (
            "codex.entry.create",
            entry_create("entry-a", "Alice", "ent:alice"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-b", "Bob", "ent:bob"),
        ),
        (
            "codex.relation.create",
            relation_create("rel-1", "ent:alice", "ent:bob", None),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-1", "set-codex-1", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-codex-1",
            "digest-codex-1",
            "set-codex-1",
            "run-codex-1",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);
    assert_eq!(
        applied["entityBindings"]["ent:alice"]["codexEntryId"],
        "entry-a"
    );
    assert_eq!(applied["entityBindings"]["ent:bob"]["source"], "created");

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    let relation_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_relations", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 2);
    assert_eq!(relation_count, 1);
}

#[test]
fn relation_failure_rolls_back_entries() {
    let db = migrated_db();
    let items = [
        (
            "codex.entry.create",
            entry_create("entry-a2", "Alice", "ent:alice"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-b2", "Bob", "ent:bob"),
        ),
        (
            "codex.relation.create",
            relation_create("rel-bad", "ent:alice", "ent:alice", None),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-2", "set-codex-2", &items);
    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-codex-fail",
            "digest-codex-fail",
            "set-codex-2",
            "run-codex-2",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect_err("should fail");
    assert!(err.to_string().contains("NEX_CODEX_SELF_RELATION"));

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 0);
}

#[test]
fn change_feed_failure_rolls_back_domain_and_canonical_event() {
    let db = migrated_db();
    let items = [(
        "codex.entry.create",
        entry_create("entry-feed-fail", "Rollback", "ent:feed-fail"),
    )];
    let pairs = seed_approved_proposals(&db, "run-feed-fail", "set-feed-fail", &items);
    let prepare = build_prepare(
        "req-feed-fail",
        "digest-feed-fail",
        "set-feed-fail",
        "run-feed-fail",
        ops_from_pairs(&pairs, &items),
        vec![],
    );
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(&db, prepare.clone())
        .expect("prepare");
    let before_change_events: i64 = db
        .with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER test_reject_narrative_change_event
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'TEST_CHANGE_FEED_APPEND_FAILED');
                 END;",
            )?;
            Ok(conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?)
        })
        .expect("install feed failpoint");

    let error = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: prepare.project_id,
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: prepare.request_id,
            session_id: prepare.session_id,
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect_err("feed append must fail the whole commit");
    assert!(
        error.to_string().contains("TEST_CHANGE_FEED_APPEND_FAILED"),
        "unexpected error: {error}"
    );

    db.with_conn(|conn| {
        let commit_status: String = conn.query_row(
            "SELECT status FROM narrative_apply_commits WHERE id = ?1",
            [prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?;
        assert_eq!(commit_status, "failed");
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |row| row
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_proposal_applications",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get::<_, i64>(0)
            )?,
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM narrative_change_events", [], |row| {
                row.get::<_, i64>(0)
            })?,
            0
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row
                .get::<_, i64>(0))?,
            before_change_events
        );
        Ok(())
    })
    .expect("verify atomic rollback");
}

#[test]
fn patch_create_and_relation_atomic() {
    let db = migrated_db();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'Existing', '[]', '', '{}', NULL, 3, 't', 't')",
        &[Value::String("entry-existing".to_string())],
        "run",
    )
    .expect("seed existing");

    let items = [
        (
            "codex.entry.patch",
            json!({
                "entryId": "entry-existing",
                "baseVersion": 3,
                "aliases": { "kind": "set", "values": ["灰の目"] },
                "summary": { "kind": "fill-if-empty", "value": "監察官" },
                "name": { "kind": "leave" },
                "typeSlug": { "kind": "leave" },
                "parentId": { "kind": "leave" },
                "narrativeEntityId": "ent:existing"
            }),
        ),
        (
            "codex.entry.create",
            entry_create("entry-new", "Belka", "ent:belka"),
        ),
        (
            "codex.relation.create",
            relation_create("rel-2", "ent:existing", "ent:belka", None),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-3", "set-codex-3", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-codex-3",
            "digest-codex-3",
            "set-codex-3",
            "run-codex-3",
            ops_from_pairs(&pairs, &items),
            vec![EntityBindingSeed {
                narrative_entity_id: "ent:existing".to_string(),
                codex_entry_id: "entry-existing".to_string(),
                source: "existing".to_string(),
            }],
        ),
    );
    assert_eq!(applied["status"], "applied");

    db.with_conn(|conn| {
        let (aliases, summary, version): (String, String, i64) = conn.query_row(
            "SELECT aliases, summary, version FROM codex_entries WHERE id = 'entry-existing'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert!(aliases.contains("灰の目"));
        assert_eq!(summary, "監察官");
        assert_eq!(version, 4);
        Ok(())
    })
    .unwrap();
}

#[test]
fn semantic_duplicate_relation_is_rejected() {
    let db = migrated_db();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'A', '[]', '', '{}', NULL, 1, 't', 't')",
        &[Value::String("entry-a".to_string())],
        "run",
    )
    .unwrap();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'B', '[]', '', '{}', NULL, 1, 't', 't')",
        &[Value::String("entry-b".to_string())],
        "run",
    )
    .unwrap();

    let key = "s\tproject-1\tentry-a\tentry-b\tfriend\t友人";
    db.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             directionality, inverse_label, semantic_key, version, created_at, updated_at)
         VALUES ('rel-old', 'project-1', 'entry-a', 'entry-b', 'friend', '友人',
                 'symmetric', '友人', ?, 1, 't', 't')",
        &[Value::String(key.to_string())],
        "run",
    )
    .unwrap();

    let items = [(
        "codex.relation.create",
        json!({
            "relationId": "rel-new",
            "fromCodexId": "entry-a",
            "toCodexId": "entry-b",
            "relationType": "friend",
            "directionality": "symmetric",
            "forwardLabel": "友人",
            "inverseLabel": "友人",
            "semanticKey": key
        }),
    )];
    let pairs = seed_approved_proposals(&db, "run-codex-4", "set-codex-4", &items);
    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-dup",
            "digest-dup",
            "set-codex-4",
            "run-codex-4",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect_err("duplicate");
    assert!(err
        .to_string()
        .contains("NEX_CODEX_RELATION_SEMANTIC_DUPLICATE"));
}

#[test]
fn commit_map_conflict_and_payload_mismatch_are_rejected() {
    let db = migrated_db();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'A', '[]', '', '{}', NULL, 1, 't', 't')",
        &[Value::String("entry-a".to_string())],
        "run",
    )
    .unwrap();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'B', '[]', '', '{}', NULL, 1, 't', 't')",
        &[Value::String("entry-b".to_string())],
        "run",
    )
    .unwrap();

    let items = [(
        "codex.relation.create",
        json!({
            "relationId": "rel-map",
            "subjectEntityId": "ent:a",
            "objectEntityId": "ent:b",
            "fromCodexId": "entry-a",
            "toCodexId": "entry-wrong",
            "relationType": "friend",
            "directionality": "symmetric",
            "forwardLabel": "友人",
            "inverseLabel": "友人"
        }),
    )];
    let pairs = seed_approved_proposals(&db, "run-codex-map", "set-codex-map", &items);
    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-map",
            "digest-map",
            "set-codex-map",
            "run-codex-map",
            ops_from_pairs(&pairs, &items),
            vec![
                EntityBindingSeed {
                    narrative_entity_id: "ent:a".to_string(),
                    codex_entry_id: "entry-a".to_string(),
                    source: "existing".to_string(),
                },
                EntityBindingSeed {
                    narrative_entity_id: "ent:b".to_string(),
                    codex_entry_id: "entry-b".to_string(),
                    source: "existing".to_string(),
                },
            ],
        ),
    )
    .expect_err("endpoint mismatch");
    assert!(err.to_string().contains("NEX_COMMIT_MAP_ENDPOINT_MISMATCH"));

    // Conflicting seed bindings for the same NarrativeEntityId.
    let items2 = [(
        "codex.relation.create",
        relation_create("rel-conflict", "ent:a", "ent:b", None),
    )];
    let pairs2 = seed_approved_proposals(&db, "run-codex-conflict", "set-codex-conflict", &items2);
    let err2 = prepare_then_apply(
        &db,
        build_prepare(
            "req-conflict",
            "digest-conflict",
            "set-codex-conflict",
            "run-codex-conflict",
            ops_from_pairs(&pairs2, &items2),
            vec![
                EntityBindingSeed {
                    narrative_entity_id: "ent:a".to_string(),
                    codex_entry_id: "entry-a".to_string(),
                    source: "existing".to_string(),
                },
                EntityBindingSeed {
                    narrative_entity_id: "ent:a".to_string(),
                    codex_entry_id: "entry-b".to_string(),
                    source: "existing".to_string(),
                },
                EntityBindingSeed {
                    narrative_entity_id: "ent:b".to_string(),
                    codex_entry_id: "entry-b".to_string(),
                    source: "existing".to_string(),
                },
            ],
        ),
    )
    .expect_err("map conflict");
    assert!(err2.to_string().contains("NEX_COMMIT_MAP_CONFLICT"));
}

#[test]
fn revision_payload_mismatch_is_rejected() {
    let db = migrated_db();
    let seeded = [(
        "codex.entry.create",
        entry_create("entry-seed", "Seed", "ent:seed"),
    )];
    let pairs = seed_approved_proposals(&db, "run-codex-mismatch", "set-codex-mismatch", &seeded);
    let mismatched = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        "codex.entry.create".to_string(),
        entry_create("entry-other", "Other", "ent:other"),
    )];
    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-mismatch",
            "digest-mismatch",
            "set-codex-mismatch",
            "run-codex-mismatch",
            mismatched,
            vec![],
        ),
    )
    .expect_err("payload mismatch");
    assert!(err.to_string().contains("NEX_PROPOSAL_PAYLOAD_MISMATCH"));
}

#[test]
fn undo_deletes_relation_before_entries() {
    let db = migrated_db();
    let items = [
        ("codex.entry.create", entry_create("entry-u1", "A", "ent:a")),
        ("codex.entry.create", entry_create("entry-u2", "B", "ent:b")),
        (
            "codex.relation.create",
            relation_create("rel-u", "ent:a", "ent:b", None),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-5", "set-codex-5", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-undo-codex",
            "digest-undo-codex",
            "set-codex-5",
            "run-codex-5",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    let schema20_undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("schema20-initial-undo".to_string()),
        },
    )
    .expect("initial undo");
    assert_eq!(schema20_undone["status"], "undone");

    // Simulate a SCHEMA 20 commit that was already undone before 20→21. Its
    // receipt changeEventUid points at the latest Undo event, while the root
    // apply event remains in the canonical ledger. Redo must recover that
    // root by commit identity instead of treating the receipt UID as apply.
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM narrative_change_transactions WHERE commit_id = ?1",
            [&commit_id],
        )?;
        conn.execute(
            "UPDATE narrative_apply_commits
                SET receipt_json = json_remove(
                    receipt_json,
                    '$.maintenanceTransactionId',
                    '$.maintenanceOriginalTransactionId',
                    '$.maintenanceEventIds'
                )
              WHERE id = ?1",
            [&commit_id],
        )?;
        Ok(())
    })
    .expect("simulate pre-feed already-undone commit");

    let redone = narrative_extraction::narrative_extraction_redo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id.clone()),
            request_id: Some("schema20-redo".to_string()),
        },
    )
    .expect("redo");
    assert_eq!(redone["status"], "redone");

    let undone_again = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("schema20-second-undo".to_string()),
        },
    )
    .expect("second undo");
    assert_eq!(undone_again["status"], "undone");

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    let relation_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_relations", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 0);
    assert_eq!(relation_count, 0);

    let feed_rows: Vec<(String, Option<String>, String, String)> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT t.id, t.original_transaction_id, t.cause_kind, e.mutation_kind
                   FROM narrative_change_transactions t
                   INNER JOIN narrative_change_events e
                     ON e.project_id = t.project_id AND e.transaction_id = t.id
                  WHERE t.project_id = 'project-1' AND t.commit_id = ?1
                  ORDER BY t.source_change_event_sequence, e.event_ordinal",
            )?;
            let rows = statement
                .query_map([applied["commitId"].as_str().unwrap()], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("read maintenance feed");
    assert_eq!(
        feed_rows.len(),
        12,
        "historical forward/undo plus new redo/undo x three entities"
    );
    let forward_transaction_id = feed_rows[0].0.as_str();
    let expectations = [
        (0..3, ("forward", "create"), None),
        (3..6, ("undo", "delete"), Some(forward_transaction_id)),
        (6..9, ("redo", "restore"), Some(forward_transaction_id)),
        (9..12, ("undo", "delete"), Some(forward_transaction_id)),
    ];
    for (index, expected, expected_origin) in expectations {
        for row in &feed_rows[index] {
            assert_eq!(row.2, expected.0);
            assert_eq!(row.3, expected.1);
            assert_eq!(row.1.as_deref(), expected_origin);
        }
    }
}

#[test]
fn external_dependency_blocks_undo() {
    let db = migrated_db();
    let items = [
        (
            "codex.entry.create",
            entry_create("entry-x1", "X1", "ent:x1"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-x2", "X2", "ent:x2"),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-6", "set-codex-6", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-ext",
            "digest-ext",
            "set-codex-6",
            "run-codex-6",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    // Human adds an external relation after commit.
    db.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             directionality, inverse_label, semantic_key, version, created_at, updated_at)
         VALUES ('rel-ext', 'project-1', 'entry-x1', 'entry-x2', 'enemy', '敵',
                 'symmetric', '敵', 's\tproject-1\tentry-x1\tentry-x2\tenemy\t敵', 1, 't', 't')",
        &[],
        "run",
    )
    .expect("external relation");

    let err = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("codex-external-relation-undo".to_string()),
        },
    )
    .expect_err("external dep");
    assert!(err.to_string().contains("NEX_UNDO_EXTERNAL_DEPENDENCY"));

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 2);
}

#[test]
fn external_tag_dependency_blocks_undo() {
    let db = migrated_db();
    let items = [(
        "codex.entry.create",
        entry_create("entry-tag", "Tagged", "ent:tag"),
    )];
    let pairs = seed_approved_proposals(&db, "run-codex-tag", "set-codex-tag", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-tag",
            "digest-tag",
            "set-codex-tag",
            "run-codex-tag",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    db.execute(
        "INSERT INTO codex_tags (id, project_id, name)
         VALUES ('tag-1', 'project-1', 'hero')",
        &[],
        "run",
    )
    .expect("tag");
    db.execute(
        "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES ('entry-tag', 'tag-1')",
        &[],
        "run",
    )
    .expect("entry tag");

    let err = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("codex-external-tag-undo".to_string()),
        },
    )
    .expect_err("tag dep");
    assert!(err.to_string().contains("NEX_UNDO_EXTERNAL_DEPENDENCY"));
}

#[test]
fn patch_undo_redo_undo_cycle_refreshes_journal_versions() {
    let db = migrated_db();
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', 'Existing', '[]', '', '{}', NULL, 3, 't', 't')",
        &[Value::String("entry-patch-cycle".to_string())],
        "run",
    )
    .expect("seed existing");

    let items = [(
        "codex.entry.patch",
        json!({
            "entryId": "entry-patch-cycle",
            "baseVersion": 3,
            "aliases": { "kind": "set", "values": ["灰の目"] },
            "summary": { "kind": "fill-if-empty", "value": "監察官" },
            "name": { "kind": "leave" },
            "typeSlug": { "kind": "leave" },
            "parentId": { "kind": "leave" },
            "narrativeEntityId": "ent:patch-cycle"
        }),
    )];
    let pairs = seed_approved_proposals(&db, "run-patch-cycle", "set-patch-cycle", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-patch-cycle",
            "digest-patch-cycle",
            "set-patch-cycle",
            "run-patch-cycle",
            ops_from_pairs(&pairs, &items),
            vec![EntityBindingSeed {
                narrative_entity_id: "ent:patch-cycle".to_string(),
                codex_entry_id: "entry-patch-cycle".to_string(),
                source: "existing".to_string(),
            }],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();
    let replay_payload = |request_id: String| UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess".to_string(),
        surface: None,
        commit_id: Some(commit_id.clone()),
        request_id: Some(request_id),
    };

    for cycle in 1..=2 {
        let undone = narrative_extraction::narrative_extraction_undo_commit(
            &db,
            replay_payload(format!("codex-patch-undo-{cycle}")),
        )
        .unwrap_or_else(|err| panic!("undo cycle {cycle}: {err}"));
        assert_eq!(undone["status"], "undone");

        let (aliases, summary): (String, String) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT aliases, summary FROM codex_entries WHERE id = 'entry-patch-cycle'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .unwrap();
        assert!(
            !aliases.contains("灰の目"),
            "undo must restore pre-patch aliases"
        );
        assert_eq!(summary, "", "undo must restore empty summary");

        let redone = narrative_extraction::narrative_extraction_redo_commit(
            &db,
            replay_payload(format!("codex-patch-redo-{cycle}")),
        )
        .unwrap_or_else(|err| panic!("redo cycle {cycle}: {err}"));
        assert_eq!(redone["status"], "redone");

        let (aliases, summary, version): (String, String, i64) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT aliases, summary, version FROM codex_entries WHERE id = 'entry-patch-cycle'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?)
            })
            .unwrap();
        assert!(aliases.contains("灰の目"));
        assert_eq!(summary, "監察官");
        assert!(version > 3);
    }

    let undone_final = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        replay_payload("codex-patch-undo-final".to_string()),
    )
    .expect("final undo");
    assert_eq!(undone_final["status"], "undone");
}

#[test]
fn envelope_revise_and_decide_prepare_apply_succeeds() {
    let db = migrated_db();
    let initial_payload = entry_create("entry-env", "Envelope Hero", "ent:env");
    let (proposal_id, rev1) = seed_single_codex_proposal(
        &db,
        "run-env-apply",
        "set-env-apply",
        "prop-env-apply",
        "codex.entry.create",
        initial_payload.clone(),
    );

    let compiled_payload = entry_create("entry-env", "Envelope Hero", "ent:env");
    let envelope = codex_review_envelope(
        json!({ "editorNotes": "approved via envelope" }),
        "codex.entry.create",
        compiled_payload.clone(),
    );

    let revised = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-env-apply".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: envelope,
            expected_current_revision_id: rev1,
            decision: "approved".to_string(),
            decision_json: Some(json!({ "source": "envelope-test" })),
            created_by: Some("reviewer".to_string()),
            reconciliation_envelope: Some(test_envelope("run-env-apply", "run-env-apply-task")),
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("revise and decide");
    let revision_id = revised["revisionId"].as_str().unwrap().to_string();
    assert_eq!(revised["decision"], "approved");

    let ops = vec![(
        proposal_id.clone(),
        revision_id.clone(),
        "codex.entry.create".to_string(),
        compiled_payload,
    )];
    let apply_payload = build_prepare(
        "req-env-apply",
        "digest-env-apply",
        "set-env-apply",
        "run-env-apply",
        ops,
        vec![],
    );

    enable_manual_apply(&db);
    let applied = prepare_and_apply(&db, apply_payload);
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 1);
    assert_eq!(applied["created"][0]["entityId"], "entry-env");

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*) FROM codex_entries WHERE id = 'entry-env'",
                [],
                |r| r.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(entry_count, 1);
}

#[test]
fn envelope_revision_rejects_operation_payload_mismatch() {
    let db = migrated_db();
    let initial_payload = entry_create("entry-mismatch-env", "Seed", "ent:mismatch-env");
    let (proposal_id, rev1) = seed_single_codex_proposal(
        &db,
        "run-env-mismatch",
        "set-env-mismatch",
        "prop-env-mismatch",
        "codex.entry.create",
        initial_payload,
    );

    let compiled_payload = entry_create("entry-mismatch-env", "Compiled", "ent:mismatch-env");
    let envelope = codex_review_envelope(
        json!({ "note": "stored compiled payload" }),
        "codex.entry.create",
        compiled_payload,
    );

    let revised = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-env-mismatch".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: envelope,
            expected_current_revision_id: rev1,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
            reconciliation_envelope: Some(test_envelope(
                "run-env-mismatch",
                "run-env-mismatch-task",
            )),
            inherit_reconciliation_envelope: None,
        },
    )
    .expect("revise and decide");
    let revision_id = revised["revisionId"].as_str().unwrap().to_string();

    let mismatched_ops = vec![(
        proposal_id,
        revision_id,
        "codex.entry.create".to_string(),
        entry_create("entry-mismatch-env", "Different", "ent:mismatch-env"),
    )];
    let err = prepare_then_apply(
        &db,
        build_prepare(
            "req-env-mismatch",
            "digest-env-mismatch",
            "set-env-mismatch",
            "run-env-mismatch",
            mismatched_ops,
            vec![],
        ),
    )
    .expect_err("envelope vs operation payload mismatch");
    assert!(
        err.to_string().contains("NEX_PROPOSAL_PAYLOAD_MISMATCH"),
        "unexpected error: {err}"
    );
}

#[test]
fn partial_apply_review_bundle_and_resumable_runs() {
    let db = migrated_db();
    let items = [
        (
            "codex.entry.create",
            entry_create("entry-partial-a", "Alice", "ent:partial-a"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-partial-b", "Bob", "ent:partial-b"),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-partial", "set-partial", &items);
    let proposal_a = pairs[0].0.clone();
    let proposal_b = pairs[1].0.clone();

    let applied_a = prepare_and_apply(
        &db,
        build_prepare(
            "req-partial-a",
            "digest-partial-a",
            "set-partial",
            "run-partial",
            ops_from_pairs(&pairs[0..1], &items[0..1]),
            vec![],
        ),
    );
    assert_eq!(applied_a["status"], "applied");

    let bundle = narrative_extraction::narrative_extraction_get_run_review_bundle(
        &db,
        RunRefPayload {
            run_id: "run-partial".to_string(),
            project_id: "project-1".to_string(),
        },
    )
    .expect("review bundle");

    let proposals = bundle["proposals"].as_array().expect("proposals");
    assert_eq!(proposals.len(), 2);

    let row_a = proposals
        .iter()
        .find(|row| row["proposalId"] == proposal_a)
        .expect("proposal A");
    let row_b = proposals
        .iter()
        .find(|row| row["proposalId"] == proposal_b)
        .expect("proposal B");

    assert!(row_a["application"].is_object());
    assert_eq!(row_a["application"]["appliedEntityId"], "entry-partial-a");
    assert!(row_b["application"].is_null());

    let listed = narrative_extraction::narrative_extraction_list_resumable_runs(
        &db,
        ListResumableRunsPayload {
            project_id: "project-1".to_string(),
            surface_path_id: Some("codex.extract".to_string()),
            limit: Some(20),
        },
    )
    .expect("list resumable");
    let run_ids: Vec<&str> = listed
        .as_array()
        .expect("array")
        .iter()
        .map(|row| row["runId"].as_str().unwrap())
        .collect();
    assert!(run_ids.contains(&"run-partial"));

    let applied_b = prepare_and_apply(
        &db,
        build_prepare(
            "req-partial-b",
            "digest-partial-b",
            "set-partial",
            "run-partial",
            ops_from_pairs(&pairs[1..2], &items[1..2]),
            vec![],
        ),
    );
    assert_eq!(applied_b["status"], "applied");
    assert_eq!(applied_b["created"].as_array().unwrap().len(), 1);
    assert_eq!(applied_b["created"][0]["entityId"], "entry-partial-b");

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 2);
}

#[test]
fn partial_apply_then_relation_with_existing_binding_seed() {
    let db = migrated_db();
    let items = [
        (
            "codex.entry.create",
            entry_create("entry-partial-rel-a", "Alice", "ent:partial-rel-a"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-partial-rel-b", "Bob", "ent:partial-rel-b"),
        ),
        (
            "codex.relation.create",
            relation_create(
                "rel-partial-rel",
                "ent:partial-rel-a",
                "ent:partial-rel-b",
                None,
            ),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-partial-rel", "set-partial-rel", &items);

    let applied_a = prepare_and_apply(
        &db,
        build_prepare(
            "req-partial-rel-a",
            "digest-partial-rel-a",
            "set-partial-rel",
            "run-partial-rel",
            ops_from_pairs(&pairs[0..1], &items[0..1]),
            vec![],
        ),
    );
    assert_eq!(applied_a["status"], "applied");
    assert_eq!(applied_a["created"].as_array().unwrap().len(), 1);
    assert_eq!(applied_a["created"][0]["entityId"], "entry-partial-rel-a");

    let applied_b = prepare_and_apply(
        &db,
        build_prepare(
            "req-partial-rel-b",
            "digest-partial-rel-b",
            "set-partial-rel",
            "run-partial-rel",
            ops_from_pairs(&pairs[1..3], &items[1..3]),
            vec![EntityBindingSeed {
                narrative_entity_id: "ent:partial-rel-a".to_string(),
                codex_entry_id: "entry-partial-rel-a".to_string(),
                source: "existing".to_string(),
            }],
        ),
    );
    assert_eq!(applied_b["status"], "applied");

    let created = applied_b["created"].as_array().expect("created");
    assert_eq!(created.len(), 2);
    let entity_kinds: Vec<&str> = created
        .iter()
        .map(|row| row["entityKind"].as_str().unwrap())
        .collect();
    assert!(entity_kinds.contains(&"codex_entry"));
    assert!(entity_kinds.contains(&"codex_relation"));

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    let relation_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_relations", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 2);
    assert_eq!(relation_count, 1);
}

#[test]
fn applied_proposal_rejects_revision_and_revise_and_decide() {
    let db = migrated_db();
    let items = [(
        "codex.entry.create",
        entry_create("entry-applied-guard", "Guard", "ent:applied-guard"),
    )];
    let pairs = seed_approved_proposals(&db, "run-applied-guard", "set-applied-guard", &items);
    let proposal_id = pairs[0].0.clone();
    let revision_id = pairs[0].1.clone();

    prepare_and_apply(
        &db,
        build_prepare(
            "req-applied-guard",
            "digest-applied-guard",
            "set-applied-guard",
            "run-applied-guard",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );

    let revision_err = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-applied-guard".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            payload_json: entry_create("entry-applied-guard", "Revised", "ent:applied-guard"),
            expected_current_revision_id: revision_id.clone(),
            created_by: Some("test".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect_err("revision after apply");
    assert!(
        revision_err
            .to_string()
            .contains("NEX_PROPOSAL_ALREADY_APPLIED"),
        "unexpected error: {revision_err}"
    );

    let revise_err = narrative_extraction::narrative_extraction_revise_and_decide(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-applied-guard".to_string(),
            project_id: "project-1".to_string(),
            proposal_id,
            payload_json: entry_create("entry-applied-guard", "Revised", "ent:applied-guard"),
            expected_current_revision_id: revision_id,
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("test".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect_err("revise_and_decide after apply");
    assert!(
        revise_err
            .to_string()
            .contains("NEX_PROPOSAL_ALREADY_APPLIED"),
        "unexpected error: {revise_err}"
    );
}

#[test]
fn prepare_apply_then_status_first_retry_is_idempotent() {
    let db = migrated_db();
    let items = [(
        "codex.entry.create",
        entry_create("entry-retry", "Retry Hero", "ent:retry"),
    )];
    let pairs = seed_approved_proposals(&db, "run-retry", "set-retry", &items);
    let request_id = "req-retry-idem";
    let plan_digest = "digest-retry-idem";

    let ops = ops_from_pairs(&pairs, &items);
    let apply_payload = build_prepare(
        request_id,
        plan_digest,
        "set-retry",
        "run-retry",
        ops.clone(),
        vec![],
    );

    enable_manual_apply(&db);
    let prepared =
        narrative_extraction::narrative_extraction_prepare_commit(&db, apply_payload.clone())
            .expect("prepare");
    assert_eq!(prepared["ok"], true);

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: apply_payload.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: apply_payload.request_id.clone(),
            session_id: apply_payload.session_id.clone(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 1);
    assert_eq!(applied["created"][0]["entityId"], "entry-retry");

    let status = narrative_extraction::narrative_extraction_get_commit_status(
        &db,
        GetCommitStatusPayload {
            project_id: "project-1".to_string(),
            commit_id: None,
            request_id: Some(request_id.to_string()),
        },
    )
    .expect("status");
    assert_eq!(status["found"], true);
    assert_eq!(status["status"], "applied");
    assert!(status["receipt"].is_object(), "receipt must be present");

    // Product retry path: status-first short-circuit, then idempotent apply replay.
    let status_again = narrative_extraction::narrative_extraction_get_commit_status(
        &db,
        GetCommitStatusPayload {
            project_id: "project-1".to_string(),
            commit_id: None,
            request_id: Some(request_id.to_string()),
        },
    )
    .expect("status again");
    assert_eq!(status_again["found"], true);
    assert_eq!(status_again["status"], "applied");

    let replayed = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: apply_payload.project_id.clone(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: apply_payload.request_id.clone(),
            session_id: apply_payload.session_id.clone(),
            expected_version: None,
        },
    )
    .expect("replay");
    assert!(
        replayed["status"] == "applied" || replayed["idempotentReplay"] == true,
        "replay should report applied or idempotentReplay: {replayed}"
    );
    assert_eq!(replayed["commitId"], applied["commitId"]);

    let entry_count: i64 = db
        .with_conn(|conn| {
            Ok(conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?)
        })
        .unwrap();
    assert_eq!(entry_count, 1);

    let (feed_transactions, feed_events, correlated_to_canonical): (i64, i64, i64) = db
        .with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_change_transactions
                      WHERE project_id = 'project-1'
                        AND source_domain = 'narrative.commit.apply'
                        AND request_id = ?1",
                    [request_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_change_events e
                       INNER JOIN narrative_change_transactions t
                         ON t.project_id = e.project_id AND t.id = e.transaction_id
                      WHERE t.project_id = 'project-1'
                        AND t.source_domain = 'narrative.commit.apply'
                        AND t.request_id = ?1",
                    [request_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*)
                       FROM narrative_change_transactions t
                       INNER JOIN change_events c
                         ON c.project_id = t.project_id
                        AND c.event_uid = t.source_change_event_uid
                        AND c.sequence = t.source_change_event_sequence
                      WHERE t.project_id = 'project-1'
                        AND t.source_domain = 'narrative.commit.apply'
                        AND t.request_id = ?1",
                    [request_id],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect retry feed");
    assert_eq!(
        feed_transactions, 1,
        "retry must not duplicate feed transaction"
    );
    assert_eq!(feed_events, 1, "retry must not duplicate feed event");
    assert_eq!(
        correlated_to_canonical, 1,
        "feed must reference the audit ledger"
    );

    // Re-prepare with the same ops fails once applied — status-first avoids this.
    // For codex.entry.create, ensure_entry_id_available rejects the duplicate entry id
    // before ensure_proposal_not_applied runs; proposal consumption is still proven below.
    let prepare_err = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        PrepareCommitPayload {
            project_id: "project-1".to_string(),
            run_id: "run-retry".to_string(),
            proposal_set_id: "set-retry".to_string(),
            request_id: "req-retry-second-prepare".to_string(),
            plan_digest: "digest-retry-second-prepare".to_string(),
            session_id: "sess-codex".to_string(),
            surface: Some("narrative-extraction".to_string()),
            operations: ops
                .iter()
                .map(
                    |(proposal_id, revision_id, kind, payload)| CommitOperation {
                        kind: kind.clone(),
                        payload: payload.clone(),
                        proposal_id: proposal_id.clone(),
                        revision_id: revision_id.clone(),
                    },
                )
                .collect(),
            applications: ops
                .iter()
                .map(|(proposal_id, revision_id, _, _)| CommitApplicationRef {
                    proposal_id: proposal_id.clone(),
                    revision_id: revision_id.clone(),
                })
                .collect(),
            expected_tail_ordinal: None,
            entity_bindings: vec![],
            expected_calendar_version: None,
        },
    )
    .expect_err("second prepare should fail");
    assert!(
        prepare_err.to_string().contains("already exists"),
        "re-prepare with same entry.create ops must fail: {prepare_err}"
    );

    let revision_err = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-retry".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: pairs[0].0.clone(),
            payload_json: entry_create("entry-retry", "Retry Hero", "ent:retry"),
            expected_current_revision_id: pairs[0].1.clone(),
            created_by: Some("test".to_string()),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
        },
    )
    .expect_err("revision after apply");
    assert!(
        revision_err
            .to_string()
            .contains("NEX_PROPOSAL_ALREADY_APPLIED"),
        "proposal must be marked applied: {revision_err}"
    );
}

/// Gate C2 Lane H (`application_contributions.rs`, wired in C2-T1):
/// applying a Commit must record one `narrative_application_contributions`
/// row per field `field_authority::affected_fields` reports for the
/// operation, all under the real `narrative_proposal_applications.id` --
/// not a fabricated identifier -- and all `target_state = 'unchanged'`
/// (this write just landed, so it matches exactly what was applied).
#[test]
fn apply_commit_records_application_contributions_per_affected_field() {
    let db = migrated_db();
    let items = [(
        "codex.entry.create",
        entry_create("entry-contrib", "Contrib Hero", "ent:contrib"),
    )];
    let pairs = seed_approved_proposals(&db, "run-contrib", "set-contrib", &items);
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-contrib",
            "digest-contrib",
            "set-contrib",
            "run-contrib",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    );
    assert_eq!(applied["status"], "applied");

    let proposal_id = pairs[0].0.clone();
    let revision_id = pairs[0].1.clone();
    let application_id: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM narrative_proposal_applications
                  WHERE proposal_id = ?1 AND revision_id = ?2",
                [&proposal_id, &revision_id],
                |row| row.get(0),
            )?)
        })
        .expect("find application id");

    let mut rows: Vec<(String, String, String)> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT target_object_identity, field_path, target_state
                   FROM narrative_application_contributions
                  WHERE project_id = 'project-1' AND application_id = ?1
                  ORDER BY field_path ASC",
            )?;
            let rows = statement
                .query_map([&application_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("read application contributions");
    rows.sort();

    let expected_fields = [
        "/aliases",
        "/content",
        "/name",
        "/parentId",
        "/summary",
        "/type",
    ];
    assert_eq!(
        rows.len(),
        expected_fields.len(),
        "one contribution row per codex.entry.create affected field: {rows:?}"
    );
    for (identity, field_path, target_state) in &rows {
        assert_eq!(identity, "codex-entry:entry-contrib");
        assert!(
            expected_fields.contains(&field_path.as_str()),
            "unexpected field path: {field_path}"
        );
        assert_eq!(target_state, "unchanged");
    }
}
