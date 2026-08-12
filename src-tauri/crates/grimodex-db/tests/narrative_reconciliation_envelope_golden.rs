//! Shared TS/Rust canonical digest golden for Proposal Revision Envelope V1.

use grimodex_db::narrative_extraction::{
    self, CreateRunPayload, CreateTaskSeed, ProposalSeed, SaveProposalSetPayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};

const GOLDEN: &str = include_str!("../../../../evals/fixtures/narrative/reconciliation-envelope-v1.json");

#[test]
fn native_digest_matches_shared_golden_fixture() {
    let fixture: Value = serde_json::from_str(GOLDEN).expect("golden JSON");
    let envelope = fixture["envelope"].clone();
    let expected = &fixture["expected"];

    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.execute(
        "INSERT INTO projects (id, title) VALUES (?, 'Project')",
        &[Value::String("project-1".to_string())],
        "test",
    )
    .expect("insert project");
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("run-golden".to_string()),
            project_id: "project-1".to_string(),
            surface_path_id: "golden".to_string(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "golden-spec".to_string(),
            snapshot_digest: Some("revision-7".to_string()),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some("task-golden".to_string()),
                task_kind: "golden".to_string(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create run");

    let saved = narrative_extraction::narrative_extraction_save_proposal_set(
        &db,
        SaveProposalSetPayload {
            run_id: "run-golden".to_string(),
            project_id: "project-1".to_string(),
            proposal_set_id: Some("set-golden".to_string()),
            set_kind: "golden".to_string(),
            summary_json: None,
            proposals: vec![ProposalSeed {
                proposal_id: Some("proposal-golden".to_string()),
                proposal_key: "proposal-golden".to_string(),
                kind: "golden@1".to_string(),
                payload_json: json!({ "value": "golden" }),
                reconciliation_envelope: Some(envelope),
            }],
        },
    )
    .expect("save golden proposal");
    let revision_id = saved["proposals"][0]["revisionId"]
        .as_str()
        .expect("revision id")
        .to_string();

    let persisted: (String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT reconciliation_envelope_json, reconciliation_envelope_digest
                   FROM narrative_proposal_revisions
                  WHERE id = ?1",
                [revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("load golden revision");
    assert_eq!(persisted.0, expected["canonicalJson"]);
    assert_eq!(persisted.1, expected["envelopeDigest"]);
    assert_eq!(
        fixture["envelope"]["readSetDigest"],
        expected["readSetDigest"]
    );
}
