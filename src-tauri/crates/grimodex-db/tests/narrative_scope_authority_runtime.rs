//! NIR-0 historical Scope-authority runtime RED.
//!
//! The generic artifact API must never be able to mint the reserved
//! `source.snapshot@2` authority carrier. The typed producer lands in the
//! GREEN commit; this behavioral RED uses only the existing public finish
//! route so its failure is not a missing-symbol compile failure.

use grimodex_db::narrative_extraction::{
    self, ArtifactInput, ClaimTaskPayload, CreateRunPayload, CreateTaskSeed, FinishTaskPayload,
};
use grimodex_db::Database;
use serde_json::json;

const PROJECT_ID: &str = "project-scope-runtime";
const RUN_ID: &str = "run-scope-runtime";
const TASK_ID: &str = "task-scope-runtime";

fn fixture() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'Scope Runtime')",
            [PROJECT_ID],
        )?;
        Ok(())
    })
    .expect("seed project");
    narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some(RUN_ID.to_owned()),
            project_id: PROJECT_ID.to_owned(),
            surface_path_id: "chronicle.extract".to_owned(),
            scope_json: json!({
                "folderId": "folder-root",
                "sceneIds": ["scene-one"]
            }),
            spec_json: json!({"domain": "chronicle", "version": 1}),
            spec_digest: "spec:scope-runtime".to_owned(),
            snapshot_digest: Some(
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_owned(),
            ),
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(TASK_ID.to_owned()),
                task_kind: "source.snapshot@1".to_owned(),
                input_json: None,
                priority: None,
            }],
        },
    )
    .expect("create snapshot run");
    db
}

#[test]
fn generic_finish_cannot_mint_the_reserved_scope_authority_carrier() {
    let db = fixture();
    let claimed = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: RUN_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            lease_owner: "scope-runtime-test".to_owned(),
            lease_duration_secs: Some(300),
            task_kinds: Some(vec!["source.snapshot@1".to_owned()]),
        },
    )
    .expect("claim snapshot task");
    let task = claimed.get("task").expect("claimed task");
    let attempt_id = task
        .get("attemptId")
        .and_then(serde_json::Value::as_str)
        .expect("attempt id");

    let error = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: RUN_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_id: TASK_ID.to_owned(),
            attempt_id: attempt_id.to_owned(),
            lease_owner: "scope-runtime-test".to_owned(),
            output_json: Some(json!({"snapshotDigest": "sha256:aaaa"})),
            artifacts: vec![ArtifactInput {
                artifact_id: Some("forged-scope-authority".to_owned()),
                artifact_kind: "source.snapshot@2".to_owned(),
                payload_storage: Some("inline-json".to_owned()),
                payload_json: Some(json!({"forged": true})),
                payload_ref: None,
                payload_digest: None,
            }],
            chronicle_stage_bundle: None,
        },
    )
    .expect_err("generic finish must reject the reserved authority carrier");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_TYPED_BINDING_REQUIRED"),
        "unexpected error: {error}"
    );

    db.with_conn(|conn| {
        let artifact_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@2'",
            [RUN_ID],
            |row| row.get(0),
        )?;
        let task_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
            [TASK_ID],
            |row| row.get(0),
        )?;
        assert_eq!(artifact_count, 0);
        assert_eq!(task_status, "running", "the rejected finish must roll back");
        Ok(())
    })
    .expect("inspect rollback");
}
