//! Gate B2-1 — Prepared Commit seal and apply-by-id authority.

use grimodex_db::narrative_extraction::{
    self, AppendDecisionPayload, ApplyCommitPayload, CommitApplicationRef, CommitOperation,
    CreateRunPayload, CreateTaskSeed, PrepareCommitPayload, ProposalSeed, SaveProposalSetPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy, Database,
    SetNarrativeRuntimePolicyInput, NARRATIVE_REVIEW_ONLY,
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
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, version)
         VALUES ('scene-1', 'project-1', 'scene', 'Scene', 0)",
        &[],
        "run",
    )
    .expect("insert scene");
    db
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

fn event_payload() -> Value {
    json!({
        "eventId": "event-prepared-1",
        "title": "Prepared",
        "note": null,
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": false,
        "revealSceneId": "scene-1",
        "evidenceSceneLinks": [{
            "sceneId": "scene-1",
            "expectedSceneVersion": 0,
            "evidenceAnchorIds": []
        }],
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none"
    })
}

fn envelope(run_id: &str) -> Value {
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{"inputRef": source_key, "kind": "snapshot-document"}]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": "task-prepared",
        "reconcilerId": "test.prepared",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "chronicle.event",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "snapshot-document",
            "sourceKey": source_key,
            "revisionToken": "revision-1"
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn retraction_envelope(run_id: &str, target_application_id: &str) -> Value {
    let mut envelope = envelope(run_id);
    envelope["taskId"] = Value::String("task-retract".to_string());
    envelope["changeKind"] = Value::String("retract".to_string());
    envelope["targetProjectionRef"] = Value::String(target_application_id.to_string());
    envelope
}

fn retraction_event_payload() -> Value {
    let mut payload = event_payload();
    payload["eventId"] = Value::String("event-retraction-1".to_string());
    payload["title"] = Value::String("Retraction".to_string());
    payload
}

fn seed_one_approved(db: &Database) -> (String, String, String, String) {
    let run_id = "run-prepared";
    let set_id = "set-prepared";
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-prepared".to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
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
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-prepared".to_string()),
                proposal_key: "key-prepared".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: event_payload(),
                reconciliation_envelope: Some(envelope(run_id)),
            }],
        },
    )
    .expect("save");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .unwrap()
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .unwrap()
        .to_string();
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
    (
        run_id.to_string(),
        set_id.to_string(),
        proposal_id,
        revision_id,
    )
}

fn build_prepare(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: "req-prepared-1".to_string(),
        plan_digest: "client-ignored".to_string(),
        session_id: "sess-prepared".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: event_payload(),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        applications: vec![CommitApplicationRef {
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

fn apply_prepared(db: &Database, prepared: &Value) -> anyhow::Result<Value> {
    apply_prepared_with_identity(db, prepared, "req-prepared-1", "sess-prepared")
}

fn apply_prepared_with_identity(
    db: &Database,
    prepared: &Value,
    request_id: &str,
    session_id: &str,
) -> anyhow::Result<Value> {
    narrative_extraction::narrative_extraction_apply_commit(
        db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"]
                .as_str()
                .expect("prepared commit id")
                .to_string(),
            request_id: request_id.to_string(),
            session_id: session_id.to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
}

fn patch_entry_payload() -> Value {
    json!({
        "entryId": "entry-locked",
        "baseVersion": 0,
        "summary": {"kind": "set", "value": "AI changed"}
    })
}

fn seed_locked_entry_approved(db: &Database) -> anyhow::Result<(String, String, String, String)> {
    db.execute(
        "INSERT INTO codex_entries
            (id, project_id, type, name, summary, content, version)
         VALUES ('entry-locked', 'project-1', 'character', 'Original', '', '{}', 0)",
        &[],
        "run",
    )?;
    let run_id = "run-locked";
    let set_id = "set-locked";
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "codex.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "codex" }),
            spec_digest: "spec-locked".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-prepared".to_string()),
                task_kind: "codex.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )?;
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "codex.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-locked".to_string()),
                proposal_key: "key-locked".to_string(),
                kind: "codex.entry.patch".to_string(),
                payload_json: patch_entry_payload(),
                reconciliation_envelope: Some(envelope(run_id)),
            }],
        },
    )?;
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();
    narrative_extraction::narrative_extraction_append_decision(
        db,
        AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({"actorKind": "ai"})),
            created_by: Some("agent:planner".to_string()),
        },
    )?;
    Ok((
        run_id.to_string(),
        set_id.to_string(),
        proposal_id,
        revision_id,
    ))
}

fn build_locked_prepare(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
    request_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: request_id.to_string(),
        plan_digest: "client-ignored".to_string(),
        session_id: "sess-locked".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "codex.entry.patch".to_string(),
            payload: patch_entry_payload(),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        applications: vec![CommitApplicationRef {
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        expected_tail_ordinal: None,
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

fn build_retraction_prepare(
    run_id: &str,
    set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> PrepareCommitPayload {
    PrepareCommitPayload {
        project_id: "project-1".to_string(),
        run_id: run_id.to_string(),
        proposal_set_id: set_id.to_string(),
        request_id: "req-retraction-1".to_string(),
        plan_digest: "client-ignored".to_string(),
        session_id: "sess-retraction".to_string(),
        surface: Some("narrative-extraction".to_string()),
        operations: vec![CommitOperation {
            kind: "chronicle.event.create".to_string(),
            payload: retraction_event_payload(),
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        applications: vec![CommitApplicationRef {
            proposal_id: proposal_id.to_string(),
            revision_id: revision_id.to_string(),
        }],
        expected_tail_ordinal: Some("a0".to_string()),
        entity_bindings: vec![],
        expected_calendar_version: None,
    }
}

#[test]
fn review_only_blocks_prepare() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    let err = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect_err("review-only");
    assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
}

#[test]
fn prepare_seals_prepared_commit_row() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");
    assert_eq!(prepared["ok"], true);
    assert_eq!(prepared["status"], "prepared");
    assert!(prepared["preparedCommitId"].as_str().unwrap().len() > 8);
    assert!(prepared["planDigest"].as_str().unwrap().len() == 64);
    assert!(prepared["authorityDigest"].as_str().unwrap().len() == 64);

    db.with_conn(|conn| {
        let (status, plan_json): (String, String) = conn.query_row(
            "SELECT c.status, c.prepared_plan_json
               FROM narrative_apply_commits c
              WHERE c.id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(status, "prepared");
        assert!(plan_json.contains("chronicle.event.create"));
        assert!(plan_json.contains("planFragments"));
        Ok(())
    })
    .unwrap();
}

#[test]
fn revision_envelope_and_source_basis_contract_rows_are_immutable() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, _set_id, _proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);

    let envelope_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "UPDATE narrative_proposal_revisions
                    SET reconciliation_envelope_json = '{}'
                  WHERE id = ?1",
                rusqlite::params![revision_id],
            )
            .expect_err("revision envelope JSON must be immutable");
        Ok(error.to_string())
    })?;
    assert!(envelope_error.contains("NEX_REVISION_ENVELOPE_IMMUTABLE"));

    let digest_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "UPDATE narrative_proposal_revisions
                    SET reconciliation_envelope_digest = 'sha256:tampered'
                  WHERE id = ?1",
                rusqlite::params![revision_id],
            )
            .expect_err("revision envelope digest must be immutable");
        Ok(error.to_string())
    })?;
    assert!(digest_error.contains("NEX_REVISION_ENVELOPE_IMMUTABLE"));

    let source_delete_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "DELETE FROM narrative_revision_source_basis WHERE revision_id = ?1",
                rusqlite::params![revision_id],
            )
            .expect_err("source basis rows must be immutable");
        Ok(error.to_string())
    })?;
    assert!(source_delete_error.contains("NEX_REVISION_SOURCE_BASIS_IMMUTABLE"));

    db.execute(
        "INSERT INTO narrative_revision_source_basis
            (revision_id, ordinal, source_kind, source_key, revision_token)
         VALUES (?1, 1, 'snapshot-document', ?2, 'revision-1')",
        &[
            Value::String(revision_id.clone()),
            Value::String(format!("snapshot:{run_id}:extra")),
        ],
        "test",
    )
    .expect("extra source row is observable before prepare");
    let prepare_error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, "set-prepared", "prop-prepared", &revision_id),
    )
    .expect_err("extra source basis row must fail the prepare contract");
    assert!(prepare_error
        .to_string()
        .contains("NEX_SOURCE_BASIS_STORAGE_MISMATCH"));
    Ok(())
}

#[test]
fn apply_records_source_contract_and_freshness_only_dependency() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    db.with_conn(|conn| {
        let plan_json: String = conn.query_row(
            "SELECT prepared_plan_json FROM narrative_apply_commits WHERE id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?;
        let plan: Value = serde_json::from_str(&plan_json)?;
        let contract = plan
            .get("sourceContract")
            .and_then(Value::as_object)
            .expect("sealed source contract");
        for field in [
            "revisionEnvelopeDigest",
            "aggregateSourceBasisDigest",
            "aggregateReadSetDigest",
        ] {
            assert!(contract[field].as_str().unwrap().starts_with("sha256:"));
        }
        Ok(())
    })?;

    let applied = apply_prepared(&db, &prepared).expect("apply");
    assert_eq!(applied["status"], "applied");

    db.with_conn(|conn| {
        let application_id: String = conn.query_row(
            "SELECT id
               FROM narrative_proposal_applications
              WHERE commit_id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?;
        let (freshness_status, propagation, observed_token): (String, String, String) = conn
            .query_row(
                "SELECT f.status, d.propagation, d.observed_revision_token
                   FROM narrative_projection_freshness f
                   JOIN narrative_projection_dependencies d
                     ON d.application_id = f.application_id
                  WHERE f.application_id = ?1",
                rusqlite::params![application_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        assert_eq!(freshness_status, "fresh");
        assert_eq!(propagation, "freshness-only");
        assert_eq!(observed_token, "revision-1");
        Ok(())
    })?;
    Ok(())
}

#[test]
fn stale_source_invalidates_prepared_commit_without_domain_mutation() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    db.execute(
        "UPDATE narrative_extraction_runs
            SET snapshot_digest = ?1
          WHERE id = ?2",
        &[
            Value::String("revision-2".to_string()),
            Value::String(run_id),
        ],
        "run",
    )
    .expect("advance snapshot revision");

    let error = apply_prepared(&db, &prepared).expect_err("stale source must reject apply");
    assert!(error.to_string().contains("NEX_SOURCE_BASIS_STALE"));

    db.with_conn(|conn| {
        let (status, application_count, operation_count, journal_count, change_event_count): (
            String,
            i64,
            i64,
            i64,
            i64,
        ) = conn.query_row(
            "SELECT c.status,
                    (SELECT COUNT(*) FROM narrative_proposal_applications WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_apply_operations WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_commit_journals WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM change_events
                      WHERE project_id = c.project_id AND entity_id = c.id)
               FROM narrative_apply_commits c
              WHERE c.id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
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
        assert_eq!(status, "invalidated");
        assert_eq!(application_count, 0);
        assert_eq!(operation_count, 0);
        assert_eq!(journal_count, 0);
        assert_eq!(change_event_count, 0);
        let event_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM events WHERE id = 'event-prepared-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(event_count, 0);
        Ok(())
    })?;
    Ok(())
}

#[test]
fn locked_field_invalidates_ai_apply_without_partial_mutation() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_locked_entry_approved(&db)?;
    db.execute(
        "INSERT INTO narrative_field_authority
            (project_id, entity_kind, entity_id, field_path, owner_kind,
             explicit_lock, version, updated_at)
         VALUES ('project-1', 'codex-entry', 'entry-locked', '/summary',
                 'ai', 0, 0, '2026-08-12T00:00:00.000Z')",
        &[],
        "run",
    )?;
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_locked_prepare(&run_id, &set_id, &proposal_id, &revision_id, "req-locked-1"),
    )
    .expect("prepare");

    db.execute(
        "UPDATE narrative_field_authority
            SET owner_kind = 'human', explicit_lock = 1, version = version + 1
          WHERE project_id = 'project-1'
            AND entity_kind = 'codex-entry'
            AND entity_id = 'entry-locked'
            AND field_path = '/summary'",
        &[],
        "run",
    )?;
    let error = apply_prepared_with_identity(&db, &prepared, "req-locked-1", "sess-locked")
        .expect_err("locked AI field");
    assert!(
        error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"),
        "unexpected lock error: {error}"
    );

    db.with_conn(|conn| {
        let (status, name, summary, application_count, operation_count, journal_count, event_count): (
            String,
            String,
            String,
            i64,
            i64,
            i64,
            i64,
        ) = conn.query_row(
            "SELECT c.status, e.name, e.summary,
                    (SELECT COUNT(*) FROM narrative_proposal_applications WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_apply_operations WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM narrative_commit_journals WHERE commit_id = c.id),
                    (SELECT COUNT(*) FROM change_events
                      WHERE project_id = c.project_id AND entity_id = c.id)
               FROM narrative_apply_commits c
               JOIN codex_entries e ON e.id = 'entry-locked'
              WHERE c.id = ?1",
            rusqlite::params![prepared["preparedCommitId"].as_str().unwrap()],
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
        assert_eq!(status, "invalidated");
        assert_eq!(name, "Original");
        assert_eq!(summary, "");
        assert_eq!(application_count, 0);
        assert_eq!(operation_count, 0);
        assert_eq!(journal_count, 0);
        assert_eq!(event_count, 0);
        Ok(())
    })?;

    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id.clone(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: Some(json!({"overrideFieldPaths": ["/summary"]})),
            created_by: Some("reviewer".to_string()),
        },
    )?;
    let override_prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_locked_prepare(&run_id, &set_id, &proposal_id, &revision_id, "req-locked-2"),
    )?;
    let applied =
        apply_prepared_with_identity(&db, &override_prepared, "req-locked-2", "sess-locked")?;
    assert_eq!(applied["status"], "applied");
    let name: String = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT summary FROM codex_entries WHERE id = 'entry-locked'",
            [],
            |row| row.get(0),
        )?)
    })?;
    assert_eq!(name, "AI changed");
    Ok(())
}

#[test]
fn semantic_retraction_appends_compensation_and_preserves_prior_history() -> anyhow::Result<()> {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let first_prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )?;
    apply_prepared(&db, &first_prepared)?;
    let target_application_id: String = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT id FROM narrative_proposal_applications WHERE commit_id = ?1",
            rusqlite::params![first_prepared["preparedCommitId"].as_str().unwrap()],
            |row| row.get(0),
        )?)
    })?;

    let run_id_2 = "run-retract";
    let set_id_2 = "set-retract";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id_2.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec-retract".to_string(),
            snapshot_digest: Some("revision-1".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-retract".to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )?;
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id_2.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(set_id_2.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-retract".to_string()),
                proposal_key: "key-retract".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: retraction_event_payload(),
                reconciliation_envelope: Some(retraction_envelope(
                    run_id_2,
                    &target_application_id,
                )),
            }],
        },
    )?;
    let proposal_id_2 = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("retraction proposal id")
        .to_string();
    let revision_id_2 = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("retraction revision id")
        .to_string();
    narrative_extraction::narrative_extraction_append_decision(
        &db,
        AppendDecisionPayload {
            run_id: run_id_2.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id_2.clone(),
            revision_id: revision_id_2.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
        },
    )?;

    let second_prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_retraction_prepare(run_id_2, set_id_2, &proposal_id_2, &revision_id_2),
    )?;
    let second_applied =
        apply_prepared_with_identity(&db, &second_prepared, "req-retraction-1", "sess-retraction")?;
    assert_eq!(second_applied["status"], "applied");

    db.with_conn(|conn| {
        let (prior_kind, prior_target, compensation_kind, compensation_target): (
            String,
            Option<String>,
            String,
            Option<String>,
        ) = conn.query_row(
            "SELECT prior.application_kind, prior.compensates_application_id,
                    compensation.application_kind, compensation.compensates_application_id
               FROM narrative_proposal_applications prior
               JOIN narrative_proposal_applications compensation
                 ON compensation.commit_id = ?1
              WHERE prior.id = ?2",
            rusqlite::params![
                second_prepared["preparedCommitId"].as_str().unwrap(),
                target_application_id,
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(prior_kind, "normal");
        assert_eq!(prior_target, None);
        assert_eq!(compensation_kind, "compensation");
        assert_eq!(
            compensation_target.as_deref(),
            Some(target_application_id.as_str())
        );
        Ok(())
    })?;

    let prior_revision_id: String = db.with_conn(|conn| {
        Ok(conn.query_row(
            "SELECT revision_id FROM narrative_proposal_applications WHERE id = ?1",
            rusqlite::params![target_application_id],
            |row| row.get(0),
        )?)
    })?;
    let immutable_revision_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "UPDATE narrative_proposal_revisions
                    SET payload_json = '{}'
                  WHERE id = ?1",
                rusqlite::params![prior_revision_id],
            )
            .expect_err("applied revision must be immutable");
        Ok(error.to_string())
    })?;
    assert!(immutable_revision_error.contains("NEX_IMMUTABLE_APPLIED_REVISION"));

    let immutable_decision_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "UPDATE narrative_proposal_decisions
                    SET decision = 'rejected'
                  WHERE proposal_id = ?1 AND revision_id = ?2",
                rusqlite::params![proposal_id, revision_id],
            )
            .expect_err("applied decision must be immutable");
        Ok(error.to_string())
    })?;
    assert!(immutable_decision_error.contains("NEX_IMMUTABLE_APPLIED_DECISION"));

    let immutable_application_error = db.with_conn(|conn| {
        let error = conn
            .execute(
                "DELETE FROM narrative_proposal_applications WHERE id = ?1",
                rusqlite::params![target_application_id],
            )
            .expect_err("application must be immutable");
        Ok(error.to_string())
    })?;
    assert!(immutable_application_error.contains("NEX_IMMUTABLE_APPLICATION"));
    Ok(())
}

#[test]
fn legacy_unbound_revision_fails_closed_at_prepare() {
    let db = migrated_db();
    let run_id = "run-legacy-prepare";
    let set_id = "set-legacy-prepare";
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "legacy-spec".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect("create legacy run");
    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(set_id.to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("prop-legacy-prepare".to_string()),
                proposal_key: "key-legacy-prepare".to_string(),
                kind: "chronicle.event.create".to_string(),
                payload_json: event_payload(),
                reconciliation_envelope: None,
            }],
        },
    )
    .expect("save legacy proposal");
    let proposal_id = saved["proposals"][0]["proposalId"]
        .as_str()
        .expect("proposal id")
        .to_string();
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();
    narrative_extraction::narrative_extraction_append_decision(
        &db,
        grimodex_db::narrative_extraction::AppendDecisionPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_id: proposal_id.clone(),
            revision_id: revision_id.clone(),
            decision: "approved".to_string(),
            decision_json: None,
            created_by: Some("reviewer".to_string()),
        },
    )
    .expect("approve legacy proposal for review-only proof");
    enable_manual_apply(&db);
    let error = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(run_id, set_id, &proposal_id, &revision_id),
    )
    .expect_err("legacy revision must not reach Apply");
    assert!(error.to_string().contains("NEX_REVISION_LEGACY_UNBOUND"));
}

#[test]
fn apply_requires_prepared_commit_id_and_matching_session() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");

    let missing = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: "missing".to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: None,
        },
    )
    .expect_err("missing");
    assert!(missing.to_string().contains("prepared commit not found"));

    let session_mismatch = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "wrong-session".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect_err("session");
    assert!(session_mismatch
        .to_string()
        .contains("NEX_COMMIT_SESSION_MISMATCH"));

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared["preparedCommitId"].as_str().unwrap().to_string(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("apply");
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["created"][0]["entityId"], "event-prepared-1");
}

#[test]
fn prepare_is_idempotent_for_same_request_and_native_digest() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);

    let first_payload = build_prepare(&run_id, &set_id, &proposal_id, &revision_id);
    let first =
        narrative_extraction::narrative_extraction_prepare_commit(&db, first_payload.clone())
            .expect("first prepare");
    let second = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        PrepareCommitPayload {
            plan_digest: "different-client-digest".to_string(),
            ..first_payload
        },
    )
    .expect("same native plan must replay");

    assert_eq!(second["preparedCommitId"], first["preparedCommitId"]);
    assert_eq!(second["planDigest"], first["planDigest"]);
    assert_eq!(second["idempotentReplay"], true);
}

#[test]
fn prepare_rejects_same_request_with_different_native_plan() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);

    let first_payload = build_prepare(&run_id, &set_id, &proposal_id, &revision_id);
    narrative_extraction::narrative_extraction_prepare_commit(&db, first_payload.clone())
        .expect("first prepare");
    let mut changed_payload = first_payload;
    changed_payload.operations[0].payload["title"] = json!("forged");

    let err = narrative_extraction::narrative_extraction_prepare_commit(&db, changed_payload)
        .expect_err("native plan change must conflict");
    assert!(err.to_string().contains("NEX_COMMIT_IDEMPOTENCY_CONFLICT"));
}

#[test]
fn apply_version_cas_rejects_stale_version_without_poisoning_prepared_commit() {
    let db = migrated_db();
    let (run_id, set_id, proposal_id, revision_id) = seed_one_approved(&db);
    enable_manual_apply(&db);
    let prepared = narrative_extraction::narrative_extraction_prepare_commit(
        &db,
        build_prepare(&run_id, &set_id, &proposal_id, &revision_id),
    )
    .expect("prepare");
    let prepared_commit_id = prepared["preparedCommitId"].as_str().unwrap().to_string();

    let stale = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id: prepared_commit_id.clone(),
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: Some(99),
        },
    )
    .expect_err("stale version");
    assert!(stale.to_string().contains("NEX_COMMIT_VERSION_MISMATCH"));

    let applied = narrative_extraction::narrative_extraction_apply_commit(
        &db,
        ApplyCommitPayload {
            project_id: "project-1".to_string(),
            prepared_commit_id,
            request_id: "req-prepared-1".to_string(),
            session_id: "sess-prepared".to_string(),
            expected_version: prepared["version"].as_i64(),
        },
    )
    .expect("retry after stale version");
    assert_eq!(applied["status"], "applied");
}
