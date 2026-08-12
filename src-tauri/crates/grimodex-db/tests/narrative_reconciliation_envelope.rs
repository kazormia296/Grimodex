//! Gate B2 P1 — Proposal Revision Envelope persistence and fail-closed input.

use grimodex_db::narrative_extraction::{
    self, AppendRevisionPayload, CreateRunPayload, CreateTaskSeed, ProposalSeed,
    ReconciliationEnvelopeInheritance, SaveProposalSetPayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT INTO projects (id, title) VALUES (?, 'Project')",
        &[Value::String("project-1".to_string())],
        "test",
    )
    .expect("insert project");
    db
}

fn create_run(db: &Database, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "chronicle.extract".to_string(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: "spec".to_string(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_string()),
                task_kind: "chronicle.plan-proposals".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");
}

fn envelope(run_id: &str, task_id: &str) -> Value {
    json!({
        "changeKind": "revise",
        "readSetDigest": "sha256:6fc6334c25d478c13c06bc71c83644e4709e0578798f5d6d7f0e087ec11f4481",
        "readSet": [{ "kind": "snapshot-document", "inputRef": "scene-1" }],
        "evidenceSet": [],
        "sourceBasis": [{
            "revisionToken": "revision-1",
            "sourceKey": "scene-1",
            "sourceKind": "snapshot-document"
        }],
        "proposalSchemaVersion": "1",
        "proposalSchemaId": "chronicle.event",
        "reconcilerVersion": "1.0.0",
        "reconcilerId": "test.reconciler",
        "taskId": task_id,
        "runId": run_id,
        "schemaVersion": 1
    })
}

fn save(
    db: &Database,
    run_id: &str,
    proposal_id: &str,
    reconciliation_envelope: Option<Value>,
) -> Value {
    narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some(format!("set-{proposal_id}")),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_string()),
                proposal_key: format!("key-{proposal_id}"),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "Envelope test" }),
                reconciliation_envelope,
            }],
        },
    )
    .expect("save proposal set")
}

#[test]
fn saves_canonical_envelope_and_normalized_source_basis() {
    let db = migrated_db();
    create_run(&db, "run-envelope", "task-envelope");
    let saved = save(
        &db,
        "run-envelope",
        "proposal-envelope",
        Some(envelope("run-envelope", "task-envelope")),
    );
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();

    let row: (String, String, String, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.origin_kind, r.reconciliation_envelope_json,
                        r.reconciliation_envelope_digest,
                        (SELECT COUNT(*) FROM narrative_revision_source_basis b
                          WHERE b.revision_id = r.id)
                   FROM narrative_proposal_revisions r
                  WHERE r.id = ?1",
                [revision_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("load persisted envelope");
    assert_eq!(row.0, "enveloped");
    assert!(row.1.contains("\"changeKind\":\"revise\""));
    assert!(row.2.starts_with("sha256:"));
    assert_eq!(row.2.len(), 71);
    assert_eq!(row.3, 1);
}

#[test]
fn native_rejects_read_set_digest_and_identity_mismatches() {
    let db = migrated_db();
    create_run(&db, "run-envelope-errors", "task-envelope-errors");

    let mut bad_digest = envelope("run-envelope-errors", "task-envelope-errors");
    bad_digest["readSetDigest"] =
        json!("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let digest_error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-envelope-errors".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-bad-digest".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-bad-digest".to_string()),
                proposal_key: "key-bad-digest".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "bad digest" }),
                reconciliation_envelope: Some(bad_digest),
            }],
        },
    )
    .expect_err("read-set digest mismatch must fail closed");
    assert!(digest_error
        .to_string()
        .contains("NEX_ENVELOPE_READ_SET_DIGEST_MISMATCH"));

    let mut bad_task = envelope("run-envelope-errors", "task-other");
    bad_task["readSetDigest"] =
        json!("sha256:6fc6334c25d478c13c06bc71c83644e4709e0578798f5d6d7f0e087ec11f4481");
    let error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-envelope-errors".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-bad-task".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-bad-task".to_string()),
                proposal_key: "key-bad-task".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "bad task" }),
                reconciliation_envelope: Some(bad_task),
            }],
        },
    )
    .expect_err("task mismatch must fail closed");
    assert!(error.to_string().contains("NEX_ENVELOPE_TASK_MISMATCH"));
}

#[test]
fn native_rejects_empty_source_contract_and_source_read_kind_mismatch() {
    let db = migrated_db();
    create_run(&db, "run-envelope-shape", "task-envelope-shape");

    let mut empty = envelope("run-envelope-shape", "task-envelope-shape");
    empty["sourceBasis"] = json!([]);
    let empty_source_error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-envelope-shape".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-empty-source".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-empty-source".to_string()),
                proposal_key: "key-empty-source".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "empty source" }),
                reconciliation_envelope: Some(empty),
            }],
        },
    )
    .expect_err("empty source basis must fail closed");
    assert!(empty_source_error
        .to_string()
        .contains("NEX_ENVELOPE_SOURCE_BASIS_EMPTY"));

    let mut wrong_kind = envelope("run-envelope-shape", "task-envelope-shape");
    wrong_kind["sourceBasis"][0]["sourceKind"] = json!("projection");
    let kind_error = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-envelope-shape".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-wrong-kind".to_string()),
            set_kind: "chronicle.extract.review@1".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-wrong-kind".to_string()),
                proposal_key: "key-wrong-kind".to_string(),
                kind: "chronicle.event.create@1".to_string(),
                payload_json: json!({ "title": "wrong kind" }),
                reconciliation_envelope: Some(wrong_kind),
            }],
        },
    )
    .expect_err("source/read kind mismatch must fail closed");
    assert!(kind_error
        .to_string()
        .contains("NEX_ENVELOPE_SOURCE_BASIS_KIND_MISMATCH"));
}

#[test]
fn omitted_envelope_is_explicitly_legacy_unbound() {
    let db = migrated_db();
    create_run(&db, "run-legacy", "task-legacy");
    let saved = save(&db, "run-legacy", "proposal-legacy", None);
    assert_eq!(saved["proposals"][0]["originKind"], "legacy-unbound");
    assert!(saved["proposals"][0]["reconciliationEnvelopeDigest"].is_null());
}

#[test]
fn envelope_inheritance_requires_an_explicit_parent_and_digest_cas() {
    let db = migrated_db();
    create_run(&db, "run-inherit", "task-inherit");
    let saved = save(
        &db,
        "run-inherit",
        "proposal-inherit",
        Some(envelope("run-inherit", "task-inherit")),
    );
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();
    let digest = saved["proposals"][0]["reconciliationEnvelopeDigest"]
        .as_str()
        .expect("envelope digest")
        .to_string();

    let implicit = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-inherit".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: "proposal-inherit".to_string(),
            payload_json: json!({ "title": "legacy edit" }),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: revision_id.clone(),
            created_by: Some("human".to_string()),
        },
    )
    .expect("omitted envelope creates legacy-unbound revision");
    assert_eq!(implicit["originKind"], "legacy-unbound");

    let saved_explicit = save(
        &db,
        "run-inherit",
        "proposal-inherit-explicit",
        Some(envelope("run-inherit", "task-inherit")),
    );
    let explicit_parent = saved_explicit["proposals"][0]["revisionId"]
        .as_str()
        .expect("explicit parent revision")
        .to_string();
    let explicit = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-inherit".to_string(),
            project_id: "project-1".to_string(),
            proposal_id: "proposal-inherit-explicit".to_string(),
            payload_json: json!({ "title": "inherited edit" }),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: Some(ReconciliationEnvelopeInheritance {
                parent_revision_id: explicit_parent.clone(),
                expected_envelope_digest: saved_explicit["proposals"][0]
                    ["reconciliationEnvelopeDigest"]
                    .as_str()
                    .expect("explicit envelope digest")
                    .to_string(),
            }),
            expected_current_revision_id: explicit_parent,
            created_by: Some("human".to_string()),
        },
    )
    .expect("explicit envelope inheritance");
    assert_eq!(explicit["originKind"], "enveloped");
    assert_eq!(explicit["reconciliationEnvelopeDigest"], digest);
}
