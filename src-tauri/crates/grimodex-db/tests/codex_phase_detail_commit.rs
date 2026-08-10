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

fn seed_definition(db: &Database, definition_id: &str, name: &str) {
    db.execute(
        "INSERT INTO codex_detail_definitions
            (id, project_id, type_slug, name, field_type, field_config, sort_order,
             include_in_context, version, created_at, updated_at)
         VALUES (?, 'project-1', 'character', ?, 'text', NULL, 0, 0, 0, 't', 't')",
        &[
            Value::String(definition_id.to_string()),
            Value::String(name.to_string()),
        ],
        "run",
    )
    .expect("insert definition");
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
        session_id: "sess-phase".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations,
        applications,
        expected_tail_ordinal: None,
        entity_bindings,
    }
}

#[test]
fn entity_base_detail_and_phase_atomic_commit() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");

    let pairs = seed_approved_proposals(
        &db,
        "run-pd-1",
        "set-pd-1",
        &[
            "codex.entry.create",
            "codex.detail.value.set",
            "codex.phase.create",
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
            "codex.detail.value.set".to_string(),
            json!({
                "detailValueId": "dv-1",
                "narrativeEntityId": "ent:alice",
                "definitionId": "def-age",
                "value": "17",
                "occ": { "kind": "absent" }
            }),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.phase.create".to_string(),
            json!({
                "phaseId": "phase-1",
                "narrativeEntityId": "ent:alice",
                "anchorNodeId": null,
                "label": "開幕",
                "summaryOverride": "導入",
                "detailOverrides": [
                    { "definitionId": "def-age", "value": "18" }
                ]
            }),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-pd-1", "digest-pd-1", "set-pd-1", "run-pd-1", ops, vec![]),
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"].as_array().unwrap().len(), 3);

    db.with_conn(|conn| {
        let detail_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_detail_values", [], |r| r.get(0))?;
        let phase_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_entry_phases", [], |r| r.get(0))?;
        let override_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_phase_detail_overrides",
            [],
            |r| r.get(0),
        )?;
        let content: Option<String> = conn.query_row(
            "SELECT content_override FROM codex_entry_phases WHERE id = 'phase-1'",
            [],
            |r| r.get(0),
        )?;
        let context: Option<String> = conn.query_row(
            "SELECT context_mode_override FROM codex_entry_phases WHERE id = 'phase-1'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(detail_count, 1);
        assert_eq!(phase_count, 1);
        assert_eq!(override_count, 1);
        assert!(content.is_none());
        assert!(context.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn phase_failure_rolls_back_entry_and_detail() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");

    let pairs = seed_approved_proposals(
        &db,
        "run-pd-2",
        "set-pd-2",
        &[
            "codex.entry.create",
            "codex.detail.value.set",
            "codex.phase.create",
        ],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-b", "Bob", "ent:bob"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.detail.value.set".to_string(),
            json!({
                "detailValueId": "dv-2",
                "narrativeEntityId": "ent:bob",
                "definitionId": "def-age",
                "value": "20",
                "occ": { "kind": "absent" }
            }),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.phase.create".to_string(),
            json!({
                "phaseId": "phase-bad",
                "narrativeEntityId": "ent:bob",
                "label": "壊す",
                "detailOverrides": [
                    { "definitionId": "def-missing", "value": "x" }
                ]
            }),
        ),
    ];
    let err = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-pd-fail",
            "digest-pd-fail",
            "set-pd-2",
            "run-pd-2",
            ops,
            vec![],
        ),
    )
    .expect_err("should fail");
    assert!(err.to_string().contains("def-missing"));

    db.with_conn(|conn| {
        let entry_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?;
        let detail_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_detail_values", [], |r| r.get(0))?;
        let phase_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_entry_phases", [], |r| r.get(0))?;
        assert_eq!(entry_count, 0);
        assert_eq!(detail_count, 0);
        assert_eq!(phase_count, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn patch_and_create_phase_same_commit() {
    let db = migrated_db();
    seed_definition(&db, "def-status", "状態");
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES ('entry-existing', 'project-1', 'character', 'Existing', '[]', '', '{}', NULL, 1, 't', 't')",
        &[],
        "run",
    )
    .unwrap();
    db.execute(
        "INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, summary_override, content_override,
             context_mode_override, version, created_at, updated_at)
         VALUES ('phase-existing', 'entry-existing', NULL, '旧', NULL, NULL, NULL, 2, 't', 't')",
        &[],
        "run",
    )
    .unwrap();
    db.execute(
        "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
         VALUES ('phase-existing', 'def-status', '旧値')",
        &[],
        "run",
    )
    .unwrap();

    let pairs = seed_approved_proposals(
        &db,
        "run-pd-3",
        "set-pd-3",
        &["codex.phase.patch", "codex.phase.create"],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.phase.patch".to_string(),
            json!({
                "phaseId": "phase-existing",
                "baseVersion": 2,
                "label": "更新ラベル",
                "summary": { "kind": "set", "value": "要約" },
                "detailOverrides": [
                    { "definitionId": "def-status", "value": "新値" }
                ]
            }),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.phase.create".to_string(),
            json!({
                "phaseId": "phase-new",
                "entryId": "entry-existing",
                "label": "新規",
                "detailOverrides": []
            }),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply(
            "req-pd-3",
            "digest-pd-3",
            "set-pd-3",
            "run-pd-3",
            ops,
            vec![],
        ),
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");

    db.with_conn(|conn| {
        let (label, version): (String, i64) = conn.query_row(
            "SELECT label, version FROM codex_entry_phases WHERE id = 'phase-existing'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        assert_eq!(label, "更新ラベル");
        assert_eq!(version, 3);
        let override_value: String = conn.query_row(
            "SELECT value FROM codex_phase_detail_overrides
              WHERE phase_id = 'phase-existing' AND definition_id = 'def-status'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(override_value, "新値");
        let new_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entry_phases WHERE id = 'phase-new'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(new_count, 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn undo_restores_phase_detail_commit() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");
    let pairs = seed_approved_proposals(
        &db,
        "run-pd-4",
        "set-pd-4",
        &[
            "codex.entry.create",
            "codex.detail.value.set",
            "codex.phase.create",
        ],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-u", "UndoMe", "ent:undo"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.detail.value.set".to_string(),
            json!({
                "detailValueId": "dv-u",
                "narrativeEntityId": "ent:undo",
                "definitionId": "def-age",
                "value": "1",
                "occ": { "kind": "absent" }
            }),
        ),
        (
            pairs[2].0.clone(),
            pairs[2].1.clone(),
            "codex.phase.create".to_string(),
            json!({
                "phaseId": "phase-u",
                "narrativeEntityId": "ent:undo",
                "label": "UndoPhase",
                "detailOverrides": []
            }),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-pd-4", "digest-pd-4", "set-pd-4", "run-pd-4", ops, vec![]),
    )
    .expect("apply");
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-phase".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: None,
        },
    )
    .expect("undo");
    assert_eq!(undone["status"], "undone");

    db.with_conn(|conn| {
        let entry_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_entries", [], |r| r.get(0))?;
        let detail_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_detail_values", [], |r| r.get(0))?;
        let phase_count: i64 =
            conn.query_row("SELECT COUNT(*) FROM codex_entry_phases", [], |r| r.get(0))?;
        assert_eq!(entry_count, 0);
        assert_eq!(detail_count, 0);
        assert_eq!(phase_count, 0);
        Ok(())
    })
    .unwrap();
}

#[test]
fn sticky_blocks_phase_undo() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");
    let pairs = seed_approved_proposals(
        &db,
        "run-pd-5",
        "set-pd-5",
        &["codex.entry.create", "codex.phase.create"],
    );
    let ops = vec![
        (
            pairs[0].0.clone(),
            pairs[0].1.clone(),
            "codex.entry.create".to_string(),
            entry_create("entry-s", "Sticky", "ent:sticky"),
        ),
        (
            pairs[1].0.clone(),
            pairs[1].1.clone(),
            "codex.phase.create".to_string(),
            json!({
                "phaseId": "phase-s",
                "narrativeEntityId": "ent:sticky",
                "label": "StickyPhase",
                "detailOverrides": []
            }),
        ),
    ];
    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        build_apply("req-pd-5", "digest-pd-5", "set-pd-5", "run-pd-5", ops, vec![]),
    )
    .expect("apply");
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    db.execute(
        "INSERT INTO editor_stickies
            (id, project_id, document_key, body, palette_id, color_slot,
             inline_offset, block_offset, z_index, version, tree_node_id,
             codex_entry_id, phase_id, snippet_id, chronicle_event_id, created_at, updated_at)
         VALUES ('sticky-1', 'project-1', 'codex:entry-s', '{}', 'post-it-playful', 0,
                 0, 0, 0, 0, NULL, 'entry-s', 'phase-s', NULL, NULL, 't', 't')",
        &[],
        "run",
    )
    .expect("insert sticky");

    let err = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-phase".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: None,
        },
    )
    .expect_err("sticky should block undo");
    assert!(err.to_string().contains("NEX_UNDO_EXTERNAL_DEPENDENCY"));
}
