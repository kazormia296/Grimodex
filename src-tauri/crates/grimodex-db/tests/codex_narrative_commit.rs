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
    kinds: &[&str],
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

    let proposals: Vec<ProposalSeed> = kinds
        .iter()
        .enumerate()
        .map(|(index, kind)| ProposalSeed {
            proposal_id: Some(format!("prop-{index}")),
            proposal_key: format!("key-{index}"),
            kind: kind.to_string(),
            payload_json: json!({ "index": index }),
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
            proposal_id: Some(proposal_id.clone()),
            revision_id: Some(revision_id.clone()),
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

#[test]
fn two_entries_and_relation_atomic_commit() {
    let db = migrated_db();
    let pairs = seed_approved_proposals(
        &db,
        "run-codex-1",
        "set-codex-1",
        &[
            "codex.entry.create",
            "codex.entry.create",
            "codex.relation.create",
        ],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-a", "Alice", "ent:alice"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-b", "Bob", "ent:bob"),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.relation.create".to_string(),
            relation_create("rel-1", "ent:alice", "ent:bob", None),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-codex-1",
            "digest-codex-1",
            "set-codex-1",
            "run-codex-1",
            ops,
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
    let pairs = seed_approved_proposals(
        &db,
        "run-codex-2",
        "set-codex-2",
        &[
            "codex.entry.create",
            "codex.entry.create",
            "codex.relation.create",
        ],
    );
    // Self-relation should fail after two creates, rolling everything back.
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-a2", "Alice", "ent:alice"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-b2", "Bob", "ent:bob"),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.relation.create".to_string(),
            relation_create("rel-bad", "ent:alice", "ent:alice", None),
        ),
    ];
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-codex-fail",
            "digest-codex-fail",
            "set-codex-2",
            "run-codex-2",
            ops,
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

    let pairs = seed_approved_proposals(
        &db,
        "run-codex-3",
        "set-codex-3",
        &[
            "codex.entry.patch",
            "codex.entry.create",
            "codex.relation.create",
        ],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.patch".to_string(),
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
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-new", "Belka", "ent:belka"),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.relation.create".to_string(),
            relation_create("rel-2", "ent:existing", "ent:belka", None),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-codex-3",
            "digest-codex-3",
            "set-codex-3",
            "run-codex-3",
            ops,
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

    let pairs = seed_approved_proposals(
        &db,
        "run-codex-4",
        "set-codex-4",
        &["codex.relation.create"],
    );
    let ops = vec![(
        pairs[0].0.clone(),
        pairs[0].1.clone(),
        "codex.relation.create".to_string(),
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
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-dup",
            "digest-dup",
            "set-codex-4",
            "run-codex-4",
            ops,
            vec![],
        ),
    )
    .expect_err("duplicate");
    assert!(err
        .to_string()
        .contains("NEX_CODEX_RELATION_SEMANTIC_DUPLICATE"));
}

#[test]
fn undo_deletes_relation_before_entries() {
    let db = migrated_db();
    let pairs = seed_approved_proposals(
        &db,
        "run-codex-5",
        "set-codex-5",
        &[
            "codex.entry.create",
            "codex.entry.create",
            "codex.relation.create",
        ],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-u1", "A", "ent:a"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-u2", "B", "ent:b"),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.relation.create".to_string(),
            relation_create("rel-u", "ent:a", "ent:b", None),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-undo-codex",
            "digest-undo-codex",
            "set-codex-5",
            "run-codex-5",
            ops,
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
            commit_id: Some(commit_id),
            request_id: None,
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

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
    let pairs = seed_approved_proposals(
        &db,
        "run-codex-6",
        "set-codex-6",
        &["codex.entry.create", "codex.entry.create"],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-x1", "X1", "ent:x1"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-x2", "X2", "ent:x2"),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-ext",
            "digest-ext",
            "set-codex-6",
            "run-codex-6",
            ops,
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
