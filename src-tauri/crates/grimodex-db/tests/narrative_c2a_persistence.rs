//! C2A RED contract tests.
//!
//! These tests describe the public behavior that the C2A typed writer must
//! add after D1 publishes the schema contract.  They intentionally use the
//! existing Native extraction entry points so a later implementation cannot
//! hide the behavior behind a renderer-only helper or a second persistence
//! authority.
//!
//! This file is a Phase 1/TDD artifact.  The parallel C2A lane does not run
//! Cargo until the integration owner grants the shared Rust lane.

use grimodex_core::canonical_json_digest;
use grimodex_db::narrative_extraction::{
    self, AppendRevisionPayload, CreateRunPayload, CreateTaskSeed, FinishTaskPayload, ProposalSeed,
    ReviseAndDecidePayload, SaveProposalSetPayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};

const PROJECT_A: &str = "project-a";
const PROJECT_B: &str = "project-b";
const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_A, "Project A"],
        )?;
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, ?2)",
            rusqlite::params![PROJECT_B, "Project B"],
        )?;
        Ok(())
    })
    .expect("seed projects");
    db
}

fn create_run(db: &Database, project_id: &str, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.to_owned()),
            project_id: project_id.to_owned(),
            surface_path_id: "chronicle.extract".to_owned(),
            scope_json: json!({}),
            spec_json: json!({ "domain": "chronicle" }),
            spec_digest: format!("spec:{run_id}"),
            snapshot_digest: Some("snapshot-v2".to_owned()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.to_owned()),
                task_kind: "chronicle.plan-proposals".to_owned(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");
}

fn semantic_payload(title: &str) -> Value {
    json!({
        "eventId": "event:arrival",
        "title": title,
        "note": null,
        "actuality": "actual",
        "significance": "major",
        "evidenceAnchorIds": ["anchor:arrival"],
        "evidenceDocumentRefs": ["document:1"],
        "unresolvedMetadata": {
            "participantSurfaces": [],
            "locationSurface": null,
            "temporalExpressions": []
        }
    })
}

fn proposal_payload(title: &str, secret: bool) -> Value {
    json!({
        "eventId": "event:arrival",
        "title": title,
        "note": null,
        "actuality": "actual",
        "significance": "major",
        "evidenceAnchorIds": ["anchor:arrival"],
        "evidenceDocumentRefs": ["document:1"],
        "disclosure": {
            "secret": secret,
            "revealDocumentRef": "document:3"
        },
        "unresolvedMetadata": {
            "participantSurfaces": [],
            "locationSurface": null,
            "temporalExpressions": []
        }
    })
}

fn scope() -> Value {
    json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": "scene:1"},
        "viewpoint": {"kind": "any"},
        "knowledgeHolder": {"kind": "any"},
        "audience": {"kind": "any"},
        "narrativeLayer": {"kind": "any"},
        "storyTime": {"kind": "any"},
        "readingOrder": {"kind": "any"}
    })
}

/// A valid Chronicle Envelope V2 fixture.  The semantic payload deliberately
/// excludes disclosure fields; disclosure is a Scope input, not Assertion
/// Core.  Native must recompute all digest domains before it persists this.
fn envelope_v2(run_id: &str, task_id: &str, title: &str) -> Value {
    json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": null,
            "assertionKind": "scene-event@1",
            "payloadSchemaRef": {"id": "narrative.scene-event", "version": "1"},
            "payload": semantic_payload(title),
            "scope": scope(),
            "modality": "modality-explicit-text",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": {
                "kind": "reconciler-proposal",
                "id": "grimodex.chronicle-extraction",
                "version": "1"
            }
        },
        "assertionDigests": {
            "assertionCoreDigest": DIGEST,
            "scopeDigest": DIGEST,
            "assertionDigest": DIGEST
        },
        "changeIntent": {"changeKind": "add"},
        "effectiveMaterialBasis": {
            "sourceBasis": [{
                "sourceKind": "snapshot-document",
                "sourceKey": format!("snapshot:{run_id}"),
                "revisionToken": "snapshot-v2"
            }],
            "evidenceSet": [],
            "dependencySet": [],
            "dependencySetDigest": DIGEST,
            "materialBasisDigest": DIGEST
        },
        "revisionBasis": {
            "kind": "interpretation",
            "runId": run_id,
            "taskId": task_id,
            "producer": {
                "kind": "reconciler-proposal",
                "id": "grimodex.chronicle-extraction",
                "version": "1"
            },
            "contextSet": [],
            "contextSetDigest": DIGEST,
            "componentContractDigest": DIGEST,
            "finalRequestDigest": DIGEST
        },
        "projectionBinding": {
            "proposalKind": "chronicle.create-event@1",
            "proposalSchemaRef": {
                "id": "narrative.chronicle-event.create",
                "version": "1"
            },
            "proposalPayloadDigest": DIGEST,
            "adapterContractId": "chronicle.scene-event",
            "adapterContractVersion": "1"
        }
    })
}

fn legacy_v1_envelope(run_id: &str, task_id: &str) -> Value {
    let source_key = format!("snapshot:{run_id}");
    let read_set = json!([{
        "kind": "snapshot-document",
        "inputRef": source_key,
        "revisionToken": "snapshot-v2"
    }]);
    json!({
        "schemaVersion": 1,
        "runId": run_id,
        "taskId": task_id,
        "reconcilerId": "test.reconciler",
        "reconcilerVersion": "1.0.0",
        "proposalSchemaId": "narrative.chronicle-event.create",
        "proposalSchemaVersion": "1",
        "sourceBasis": [{
            "sourceKind": "snapshot-document",
            "sourceKey": source_key,
            "revisionToken": "snapshot-v2"
        }],
        "evidenceSet": [],
        "readSet": read_set,
        "readSetDigest": format!("sha256:{}", narrative_extraction::digest_plan(&read_set)),
        "changeKind": "add"
    })
}

fn save_v2_root(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    proposal_id: &str,
    title: &str,
) -> Value {
    narrative_extraction::narrative_extraction_save_proposal_set(
        db,
        SaveProposalSetPayload {
            run_id: run_id.to_owned(),
            project_id: project_id.to_owned(),
            proposal_set_id: Some(format!("set-{proposal_id}")),
            set_kind: "chronicle.extract.review@1".to_owned(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some(proposal_id.to_owned()),
                proposal_key: "event:arrival:0".to_owned(),
                kind: "chronicle.event.create@1".to_owned(),
                payload_json: proposal_payload(title, false),
                reconciliation_envelope: Some(envelope_v2(run_id, task_id, title)),
            }],
        },
    )
    .expect("C2A must persist a valid Envelope V2 root")["proposals"][0]
        .clone()
}

fn claim_task(db: &Database, project_id: &str, run_id: &str) -> String {
    let claimed = narrative_extraction::narrative_extraction_claim_task(
        db,
        narrative_extraction::ClaimTaskPayload {
            run_id: run_id.to_owned(),
            project_id: project_id.to_owned(),
            lease_owner: "c2a-test-worker".to_owned(),
            lease_duration_secs: Some(300),
            task_kinds: None,
        },
    )
    .expect("claim task");
    claimed["task"]["attemptId"]
        .as_str()
        .expect("attempt id")
        .to_owned()
}

#[test]
fn persists_a_native_canonical_envelope_v2_and_project_scoped_revision_identity() {
    let db = migrated_db();
    create_run(&db, PROJECT_A, "run-v2-a", "task-v2-a");
    create_run(&db, PROJECT_B, "run-v2-b", "task-v2-b");

    let first = save_v2_root(
        &db,
        PROJECT_A,
        "run-v2-a",
        "task-v2-a",
        "proposal-a",
        "Arrival",
    );
    let second = save_v2_root(
        &db,
        PROJECT_B,
        "run-v2-b",
        "task-v2-b",
        "proposal-b",
        "Arrival",
    );
    let first_revision = first["revisionId"].as_str().expect("first revision");
    let second_revision = second["revisionId"].as_str().expect("second revision");
    assert_ne!(
        first_revision, second_revision,
        "revision identity is project-scoped"
    );

    let (origin, envelope_json, envelope_digest, project_id): (String, String, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.origin_kind, r.reconciliation_envelope_json,
                        r.reconciliation_envelope_digest, s.project_id
                   FROM narrative_proposal_revisions r
                   JOIN narrative_proposals p ON p.id = r.proposal_id
                   JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE r.id = ?1",
                [first_revision],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read V2 root");
    let persisted: Value = serde_json::from_str(&envelope_json).expect("canonical envelope");
    assert_eq!(origin, "enveloped");
    assert_eq!(persisted["schemaVersion"], 2);
    assert_eq!(
        envelope_digest,
        canonical_json_digest(&persisted).expect("envelope digest")
    );
    assert_eq!(first["reconciliationEnvelopeDigest"], envelope_digest);
    assert_eq!(project_id, PROJECT_A);
}

#[test]
fn rejects_malformed_stage_provenance_atomically_with_task_output_and_artifact() {
    let db = migrated_db();
    create_run(&db, PROJECT_A, "run-stage-atomic", "task-stage-atomic");
    let attempt_id = claim_task(&db, PROJECT_A, "run-stage-atomic");

    let malformed_closure = json!({
        "kind": "chronicle-stage-provenance-closure",
        "version": 1,
        "projectId": PROJECT_A,
        "runId": "run-stage-atomic",
        "ownerTaskId": "task-stage-atomic",
        "ownerAttemptId": attempt_id,
        "receipts": [],
        "receiptRefs": [],
        "stageProvenanceClosureDigest": DIGEST
    });
    let error = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-stage-atomic".to_owned(),
            project_id: PROJECT_A.to_owned(),
            task_id: "task-stage-atomic".to_owned(),
            attempt_id: attempt_id.clone(),
            lease_owner: "c2a-test-worker".to_owned(),
            output_json: Some(json!({
                "stageProvenanceClosureDigest": DIGEST,
                "output": "must roll back"
            })),
            artifacts: vec![narrative_extraction::ArtifactInput {
                artifact_id: Some("artifact-stage-atomic".to_owned()),
                artifact_kind: "chronicle.stage-provenance-closure@1".to_owned(),
                payload_storage: Some("inline-json".to_owned()),
                payload_json: Some(malformed_closure),
                payload_ref: None,
                payload_digest: None,
            }],
        },
    )
    .expect_err("malformed closure must fail closed");
    assert!(
        error.to_string().contains("stage") || error.to_string().contains("closure"),
        "unexpected closure error: {error:#}"
    );

    let (status, task_output, attempt_output, artifact_count): (
        String,
        Option<String>,
        Option<String>,
        i64,
    ) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT t.status, t.output_json, a.output_json,
                        (SELECT COUNT(*) FROM narrative_extraction_artifacts
                          WHERE id = 'artifact-stage-atomic')
                   FROM narrative_extraction_tasks t
                   JOIN narrative_extraction_attempts a ON a.id = ?1
                  WHERE t.id = 'task-stage-atomic'",
                [attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read rolled back task");
    assert_eq!(status, "running");
    assert!(task_output.is_none());
    assert!(attempt_output.is_none());
    assert_eq!(artifact_count, 0);
}

fn seed_v2_parent_for_human_writer(
    db: &Database,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    proposal_id: &str,
    revision_id: &str,
    source_revision_token: &str,
) -> Value {
    create_run(db, project_id, run_id, task_id);
    let envelope = envelope_v2(run_id, task_id, "Arrival");
    let envelope_json = serde_json::to_string(&envelope).expect("serialize parent envelope");
    let envelope_digest = canonical_json_digest(&envelope).expect("parent digest");
    let payload = proposal_payload("Arrival", false);
    let payload_json = serde_json::to_string(&payload).expect("serialize parent payload");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_proposal_sets
                (id, run_id, project_id, set_kind, summary_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'chronicle.extract.review@1', '{}', datetime('now'), datetime('now'))",
            rusqlite::params![format!("set-{proposal_id}"), run_id, project_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposals
                (id, proposal_set_id, proposal_key, kind, status, payload_json,
                 current_revision_id, created_at, updated_at)
             VALUES (?1, ?2, 'event:arrival:0', 'chronicle.event.create@1',
                     'unreviewed', ?3, ?4, datetime('now'), datetime('now'))",
            rusqlite::params![proposal_id, format!("set-{proposal_id}"), payload_json, revision_id],
        )?;
        conn.execute(
            "INSERT INTO narrative_proposal_revisions
                (id, proposal_id, revision_number, payload_json, origin_kind,
                 reconciliation_envelope_json, reconciliation_envelope_digest,
                 created_at, created_by)
             VALUES (?1, ?2, 1, ?3, 'enveloped', ?4, ?5, datetime('now'), 'chronicle')",
            rusqlite::params![revision_id, proposal_id, payload_json, envelope_json, envelope_digest],
        )?;
        conn.execute(
            "INSERT INTO narrative_revision_source_basis
                (revision_id, ordinal, source_kind, source_key, revision_token)
             VALUES (?1, 0, 'snapshot-document', ?2, ?3)",
            rusqlite::params![revision_id, format!("snapshot:{run_id}"), source_revision_token],
        )?;
        Ok(())
    })
    .expect("seed V2 parent");
    json!({"revisionId": revision_id, "envelopeDigest": envelope_digest})
}

#[test]
fn native_human_writer_computes_mixed_scope_override_and_owns_child_material_basis() {
    let db = migrated_db();
    let parent = seed_v2_parent_for_human_writer(
        &db,
        PROJECT_A,
        "run-human-derived",
        "task-human-derived",
        "proposal-human-derived",
        "revision-human-parent",
        "snapshot-v2",
    );

    let result = narrative_extraction::narrative_extraction_revise_and_decide_as_human(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-human-derived".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-human-derived".to_owned(),
            payload_json: proposal_payload("Arrival at Dawn", true),
            // The client supplies only the edited Projection payload. Native
            // must derive the child Envelope and material basis.
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            decision: "held".to_owned(),
            decision_json: None,
            created_by: Some("chronicle-dialog".to_owned()),
        },
    )
    .expect("Native human writer must accept title + secret");
    let child_revision = result["revisionId"].as_str().expect("child revision");

    let (origin, envelope_json, source_basis_count, edge_count): (String, String, i64, i64) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT r.origin_kind, r.reconciliation_envelope_json,
                        (SELECT COUNT(*) FROM narrative_revision_source_basis
                          WHERE revision_id = r.id),
                        (SELECT COUNT(*) FROM narrative_dependency_edges
                          WHERE consumer_kind = 'proposal-revision'
                            AND consumer_key = r.id)
                   FROM narrative_proposal_revisions r
                  WHERE r.id = ?1",
                [child_revision],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .expect("read human-derived child");
    let child: Value = serde_json::from_str(&envelope_json).expect("child Envelope V2");
    assert_eq!(origin, "enveloped");
    assert_eq!(child["schemaVersion"], 2);
    assert_eq!(child["revisionBasis"]["kind"], "human-derived");
    assert_eq!(
        child["revisionBasis"]["derivation"]["kind"],
        "scope-override"
    );
    assert_eq!(
        child["revisionBasis"]["derivation"]["proposalPayloadChangedPaths"],
        json!(["/title", "/disclosure/secret"])
    );
    assert_eq!(child["revisionBasis"]["revisionActor"]["kind"], "human");
    assert!(source_basis_count > 0, "child owns its Source Basis");
    assert!(
        edge_count > 0,
        "child owns its proposal-revision Consumer Edges"
    );
}

#[test]
fn native_human_writer_rejects_client_envelope_and_unsupported_assertion_edit() {
    let db = migrated_db();
    let parent = seed_v2_parent_for_human_writer(
        &db,
        PROJECT_A,
        "run-human-boundary",
        "task-human-boundary",
        "proposal-human-boundary",
        "revision-human-boundary-parent",
        "snapshot-v2",
    );

    let forged_envelope_error =
        narrative_extraction::narrative_extraction_revise_and_decide_as_human(
            &db,
            ReviseAndDecidePayload {
                run_id: "run-human-boundary".to_owned(),
                project_id: PROJECT_A.to_owned(),
                proposal_id: "proposal-human-boundary".to_owned(),
                payload_json: proposal_payload("Forged envelope", false),
                reconciliation_envelope: Some(legacy_v1_envelope(
                    "run-human-boundary",
                    "task-human-boundary",
                )),
                inherit_reconciliation_envelope: None,
                expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
                decision: "held".to_owned(),
                decision_json: None,
                created_by: Some("untrusted-renderer".to_owned()),
            },
        )
        .expect_err("human clients cannot submit a completed envelope");
    assert!(!forged_envelope_error.to_string().is_empty());

    let mut unsupported_payload = proposal_payload("Unsupported edit", false);
    unsupported_payload["actuality"] = json!("projected");
    let unsupported_error = narrative_extraction::narrative_extraction_revise_and_decide_as_human(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-human-boundary".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-human-boundary".to_owned(),
            payload_json: unsupported_payload,
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            decision: "held".to_owned(),
            decision_json: None,
            created_by: Some("chronicle-dialog".to_owned()),
        },
    )
    .expect_err("human writer must reject assertion-affecting paths");
    assert!(!unsupported_error.to_string().is_empty());
}

#[test]
fn v2_lineage_rejects_legacy_unbound_children_and_sql_downgrade_inserts() {
    let db = migrated_db();
    let parent = seed_v2_parent_for_human_writer(
        &db,
        PROJECT_A,
        "run-monotonic",
        "task-monotonic",
        "proposal-monotonic",
        "revision-monotonic-parent",
        "snapshot-v2",
    );

    let append_error = narrative_extraction::narrative_extraction_append_revision(
        &db,
        AppendRevisionPayload {
            run_id: "run-monotonic".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-monotonic".to_owned(),
            payload_json: proposal_payload("Legacy downgrade", false),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            created_by: Some("legacy-client".to_owned()),
        },
    )
    .expect_err("typed writer must reject V2 to legacy-unbound downgrade");
    assert!(append_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));

    let sql_error = db
        .with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     created_at, created_by)
                 VALUES ('revision-monotonic-sql', 'proposal-monotonic', 2, '{}',
                         'legacy-unbound', datetime('now'), 'sql-test')",
                [],
            )?;
            Ok(())
        })
        .expect_err("structural trigger must reject a non-V2 child after V2 current");
    assert!(sql_error
        .to_string()
        .contains("NEX_REVISION_ENVELOPE_DOWNGRADE_FORBIDDEN"));
}

#[test]
fn stale_human_parent_can_be_edited_but_v2_production_activation_stays_disabled() {
    // This test intentionally checks the persistence contract only.  The
    // Chronicle production entry points remain V1 until C2B; a C2A writer is
    // not allowed to turn this fixture into a production cutover.
    let db = migrated_db();
    let parent = seed_v2_parent_for_human_writer(
        &db,
        PROJECT_A,
        "run-stale-human",
        "task-stale-human",
        "proposal-stale-human",
        "revision-stale-parent",
        "live-newer-token",
    );

    let result = narrative_extraction::narrative_extraction_revise_and_decide_as_human(
        &db,
        ReviseAndDecidePayload {
            run_id: "run-stale-human".to_owned(),
            project_id: PROJECT_A.to_owned(),
            proposal_id: "proposal-stale-human".to_owned(),
            payload_json: proposal_payload("Edited while stale", false),
            reconciliation_envelope: None,
            inherit_reconciliation_envelope: None,
            expected_current_revision_id: parent["revisionId"].as_str().unwrap().to_owned(),
            decision: "held".to_owned(),
            decision_json: None,
            created_by: Some("chronicle-dialog".to_owned()),
        },
    )
    .expect("human-derived stale edit must not use interpretation live-token refusal");
    let child_revision = result["revisionId"].as_str().expect("child revision");
    let (origin, envelope_json): (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT origin_kind, reconciliation_envelope_json
                   FROM narrative_proposal_revisions
                  WHERE id = ?1",
                [child_revision],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("read stale human-derived child");
    let child: Value = serde_json::from_str(&envelope_json).expect("child Envelope V2");
    assert_eq!(origin, "enveloped");
    assert_eq!(child["schemaVersion"], 2);
    assert_eq!(child["revisionBasis"]["kind"], "human-derived");

    // Production activation is asserted by the policy/quality scanner.  Keep
    // the marker vocabulary here as a test-level contract without adding any
    // reserved activation marker to a production source file.
    let activation = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../policies/narrative/narrative-ir-contract.json"
    ));
    assert!(activation.contains("\"state\": \"disabled\""));
    assert!(activation.contains("\"v2Emission\": \"blocked-until-c2b\""));
    assert!(activation.contains("\"humanDerivedV2Ui\": \"blocked-until-c2b\""));
}
