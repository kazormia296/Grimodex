#[path = "../test-support/snapshot_restore.rs"]
mod snapshot_restore;
#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, CreateTaskSeed, EntityBindingSeed, PrepareCommitPayload, ProposalSeed,
    SaveProposalSetPayload, UndoCommitPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput,
};
use serde_json::{json, Value};

fn migrated_db() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
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
        session_id: "sess-phase".to_string(),
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

#[test]
fn entity_base_detail_and_phase_atomic_commit() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");

    let pairs = seed_approved_proposals(
        &db,
        "run-pd-1",
        "set-pd-1",
        &[
            (
                "codex.entry.create",
                entry_create("entry-a", "Alice", "ent:alice"),
            ),
            (
                "codex.detail.value.set",
                json!({
                    "detailValueId": "dv-1",
                    "narrativeEntityId": "ent:alice",
                    "definitionId": "def-age",
                    "value": "17",
                    "occ": { "kind": "absent" }
                }),
            ),
            (
                "codex.phase.create",
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
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-pd-1",
            "digest-pd-1",
            "set-pd-1",
            "run-pd-1",
            ops,
            vec![],
        ),
    );
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
            (
                "codex.entry.create",
                entry_create("entry-b", "Bob", "ent:bob"),
            ),
            (
                "codex.detail.value.set",
                json!({
                    "detailValueId": "dv-2",
                    "narrativeEntityId": "ent:bob",
                    "definitionId": "def-age",
                    "value": "20",
                    "occ": { "kind": "absent" }
                }),
            ),
            (
                "codex.phase.create",
                json!({
                    "phaseId": "phase-bad",
                    "narrativeEntityId": "ent:bob",
                    "label": "壊す",
                    "detailOverrides": [
                        { "definitionId": "def-missing", "value": "x" }
                    ]
                }),
            ),
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
    let err = prepare_then_apply(
        &db,
        build_prepare(
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
        &[
            (
                "codex.phase.patch",
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
                "codex.phase.create",
                json!({
                    "phaseId": "phase-new",
                    "entryId": "entry-existing",
                    "label": "新規",
                    "detailOverrides": []
                }),
            ),
        ],
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
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-pd-3",
            "digest-pd-3",
            "set-pd-3",
            "run-pd-3",
            ops,
            vec![],
        ),
    );
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
            (
                "codex.entry.create",
                entry_create("entry-u", "UndoMe", "ent:undo"),
            ),
            (
                "codex.detail.value.set",
                json!({
                    "detailValueId": "dv-u",
                    "narrativeEntityId": "ent:undo",
                    "definitionId": "def-age",
                    "value": "1",
                    "occ": { "kind": "absent" }
                }),
            ),
            (
                "codex.phase.create",
                json!({
                    "phaseId": "phase-u",
                    "narrativeEntityId": "ent:undo",
                    "label": "UndoPhase",
                    "detailOverrides": []
                }),
            ),
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
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-pd-4",
            "digest-pd-4",
            "set-pd-4",
            "run-pd-4",
            ops,
            vec![],
        ),
    );
    let commit_id = applied["commitId"].as_str().unwrap().to_string();

    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        UndoCommitPayload {
            project_id: "project-1".to_string(),
            session_id: "sess-phase".to_string(),
            surface: None,
            commit_id: Some(commit_id),
            request_id: Some("phase-detail-undo".to_string()),
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
        &[
            (
                "codex.entry.create",
                entry_create("entry-s", "Sticky", "ent:sticky"),
            ),
            (
                "codex.phase.create",
                json!({
                    "phaseId": "phase-s",
                    "narrativeEntityId": "ent:sticky",
                    "label": "StickyPhase",
                    "detailOverrides": []
                }),
            ),
        ],
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
    let applied = prepare_and_apply(
        &db,
        build_prepare(
            "req-pd-5",
            "digest-pd-5",
            "set-pd-5",
            "run-pd-5",
            ops,
            vec![],
        ),
    );
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
            request_id: Some("phase-sticky-dependency-undo".to_string()),
        },
    )
    .expect_err("sticky should block undo");
    assert!(err.to_string().contains("NEX_UNDO_EXTERNAL_DEPENDENCY"));
}

// --- 復元の後の取り消し・やり直し（DR-SRC-12。確かめていない種類は拒んだまま） ---
//
// Codex の phase と detail value の作成は、確認 88 の条件（専用の守りで、復元の後の編集が
// 巻き戻らないことを、試験で確かめる）を満たしていない種類である。ここで使う commit は、
// 確かめた種類（Codex の項目の作成）と確かめていない種類（detail value の作成と phase の
// 作成）が混ざっている。復元の marker の後は、取り消しが
// NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE で拒まれ、何も変わらない（やり直しは、
// detail value を含む commit では元から未対応）。
// 復元は Body の scope で行う（Codex の scope は項目の版を 0 に戻し、専用の守りが先に拒む）。

fn replay_payload(commit_id: &str, request_id: &str) -> UndoCommitPayload {
    UndoCommitPayload {
        project_id: "project-1".to_string(),
        session_id: "sess-phase".to_string(),
        surface: None,
        commit_id: Some(commit_id.to_string()),
        request_id: Some(request_id.to_string()),
    }
}

fn assert_superseded_by_restore(result: anyhow::Result<Value>, what: &str) {
    let error = result.expect_err(what);
    let message = format!("{error:#}");
    assert!(
        message.contains("NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE"),
        "{what}: expected NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE, got {message}"
    );
}

fn phase_rows(db: &Database, phase_id: &str) -> i64 {
    db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT COUNT(*) FROM codex_entry_phases WHERE id = ?1",
            [phase_id],
            |row| row.get::<_, i64>(0),
        )?)
    })
    .expect("count phases")
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

/// One commit: a Codex entry (verified kind), a detail value of it (creation,
/// not verified) and a phase of it (not verified).
fn apply_entry_detail_phase(db: &Database, tag: &str) -> String {
    let narrative_entity_id = format!("ent:{tag}");
    let items = [
        (
            "codex.entry.create",
            entry_create(
                &format!("entry-{tag}"),
                &format!("Name {tag}"),
                &narrative_entity_id,
            ),
        ),
        (
            "codex.detail.value.set",
            json!({
                "detailValueId": format!("dv-{tag}"),
                "narrativeEntityId": narrative_entity_id,
                "definitionId": "def-age",
                "value": "1",
                "occ": { "kind": "absent" }
            }),
        ),
        (
            "codex.phase.create",
            json!({
                "phaseId": format!("phase-{tag}"),
                "narrativeEntityId": narrative_entity_id,
                "label": format!("Phase {tag}"),
                "detailOverrides": []
            }),
        ),
    ];
    let pairs = seed_approved_proposals(db, &format!("run-{tag}"), &format!("set-{tag}"), &items);
    let ops = pairs
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
        .collect();
    let applied = prepare_and_apply(
        db,
        build_prepare(
            &format!("req-{tag}"),
            &format!("digest-{tag}"),
            &format!("set-{tag}"),
            &format!("run-{tag}"),
            ops,
            vec![],
        ),
    );
    assert_eq!(applied["status"], "applied");
    applied["commitId"].as_str().unwrap().to_string()
}

#[test]
fn undo_of_a_phase_commit_after_a_snapshot_restore_is_refused_and_changes_nothing() {
    let db = migrated_db();
    seed_definition(&db, "def-age", "年齢");
    let undone_before = apply_entry_detail_phase(&db, "pha");
    let applied_before = apply_entry_detail_phase(&db, "phb");
    // Without a restore, undo works: the refusal below is the restore's doing.
    let undone = narrative_extraction::narrative_extraction_undo_commit(
        &db,
        replay_payload(&undone_before, "pha-undo"),
    )
    .expect("undo before the restore");
    assert_eq!(undone["status"], "undone");

    snapshot_restore::restore_a_scene_after_snapshot(&db, "project-1", "sess-restore", "ph");

    assert_superseded_by_restore(
        narrative_extraction::narrative_extraction_undo_commit(
            &db,
            replay_payload(&applied_before, "phb-undo"),
        ),
        "undo of a phase commit after the restore",
    );
    // Nothing changed: B's phase stays, A stays undone.
    assert_eq!(phase_rows(&db, "phase-phb"), 1);
    assert_eq!(phase_rows(&db, "phase-pha"), 0);
    assert_eq!(commit_status(&db, &applied_before), "applied");
    assert_eq!(commit_status(&db, &undone_before), "undone");
}
