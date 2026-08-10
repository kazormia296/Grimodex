use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, EntityBindingSeed, ProposalSeed, SaveProposalSetPayload, UndoCommitPayload,
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
            proposal_id: Some(format!("{proposal_set_id}-prop-{index}")),
            proposal_key: format!("{proposal_set_id}-key-{index}"),
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

fn entry_create(
    entry_id: &str,
    name: &str,
    narrative_entity_id: &str,
) -> Value {
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

fn build_apply(
    request_id: &str,
    plan_digest: &str,
    proposal_set_id: &str,
    run_id: &str,
    ops: Vec<(String, String, String, Value)>,
    entity_bindings: Vec<EntityBindingSeed>,
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
        session_id: "sess-codex".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings,
    }
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-codex-1",
            "digest-codex-1",
            "set-codex-1",
            "run-codex-1",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);
    assert_eq!(
        applied["entityBindings"]["ent:alice"]["codexEntryId"],
        "entry-a"
    );
    assert_eq!(
        applied["entityBindings"]["ent:bob"]["source"],
        "created"
    );

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
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    )
    .expect("apply");
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
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    let err2 = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
        (
            "codex.entry.create",
            entry_create("entry-u1", "A", "ent:a"),
        ),
        (
            "codex.entry.create",
            entry_create("entry-u2", "B", "ent:b"),
        ),
        (
            "codex.relation.create",
            relation_create("rel-u", "ent:a", "ent:b", None),
        ),
    ];
    let pairs = seed_approved_proposals(&db, "run-codex-5", "set-codex-5", &items);
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-undo-codex",
            "digest-undo-codex",
            "set-codex-5",
            "run-codex-5",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect("apply");
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

    let redone = narrative_extraction::narrative_extraction_redo_commit(
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
    assert_eq!(redone["status"], "redone");

    let undone_again = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: None,
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-ext",
            "digest-ext",
            "set-codex-6",
            "run-codex-6",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect("apply");
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
            request_id: None,
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-tag",
            "digest-tag",
            "set-codex-tag",
            "run-codex-tag",
            ops_from_pairs(&pairs, &items),
            vec![],
        ),
    )
    .expect("apply");
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
            request_id: None,
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
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
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
    )
    .expect("apply");
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
            undo_payload.clone(),
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
        undo_payload,
    )
    .expect("final undo after redo cycles");
    assert_eq!(undone_final["status"], "undone");
}
