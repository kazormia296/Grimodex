//! NIR-0 historical Scope-authority runtime contract.

use grimodex_core::narrative_scope_authority_basis::{
    build_narrative_scope_authority_basis_v2, NarrativeScopeAuthorityBasisV2,
    NarrativeScopeAuthorityDocumentInputV2,
};
use grimodex_db::narrative_extraction::{
    self, ArtifactInput, ClaimTaskPayload, CreateRunPayload, CreateTaskSeed, FinishTaskPayload,
};
use grimodex_db::Database;
use serde_json::json;

const PROJECT_ID: &str = "project-scope-runtime";
const RUN_ID: &str = "run-scope-runtime";
const TASK_ID: &str = "task-scope-runtime";
const LEASE_OWNER: &str = "scope-runtime-test";
const SNAPSHOT_DIGEST: &str =
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn fixture() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES (?1, 'Scope Runtime')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, sort_order)
             VALUES ('folder-root', ?1, NULL, 'folder', 'Root', 'a0')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, sort_order, story_time_order)
             VALUES ('scene-one', ?1, 'folder-root', 'scene', 'One', 'a0', '0010')",
            [PROJECT_ID],
        )?;
        conn.execute(
            "INSERT INTO tree_nodes
                (id, project_id, parent_id, node_type, title, sort_order, story_time_order)
             VALUES ('scene-two', ?1, 'folder-root', 'scene', 'Two', 'a1', '0020')",
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
                "sceneIds": ["scene-one", "scene-two"]
            }),
            spec_json: json!({"domain": "chronicle", "version": 1}),
            spec_digest: "spec:scope-runtime".to_owned(),
            snapshot_digest: Some(SNAPSHOT_DIGEST.to_owned()),
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

fn claim_attempt(db: &Database) -> String {
    let claimed = narrative_extraction::narrative_extraction_claim_task(
        db,
        ClaimTaskPayload {
            run_id: RUN_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            lease_owner: LEASE_OWNER.to_owned(),
            lease_duration_secs: Some(300),
            task_kinds: Some(vec!["source.snapshot@1".to_owned()]),
        },
    )
    .expect("claim snapshot task");
    claimed["task"]["attemptId"]
        .as_str()
        .expect("attempt id")
        .to_owned()
}

fn basis_for(
    project_id: &str,
    run_id: &str,
    first_story_key: &str,
) -> NarrativeScopeAuthorityBasisV2 {
    build_narrative_scope_authority_basis_v2(
        project_id,
        run_id,
        SNAPSHOT_DIGEST,
        &[
            NarrativeScopeAuthorityDocumentInputV2 {
                document_ref: "D000001".to_owned(),
                source_key: "project:scene:scene-one".to_owned(),
                raw_story_key: Some(first_story_key.to_owned()),
            },
            NarrativeScopeAuthorityDocumentInputV2 {
                document_ref: "D000002".to_owned(),
                source_key: "project:scene:scene-two".to_owned(),
                raw_story_key: Some("0020".to_owned()),
            },
        ],
    )
    .expect("build historical basis")
}

fn basis(first_story_key: &str) -> NarrativeScopeAuthorityBasisV2 {
    basis_for(PROJECT_ID, RUN_ID, first_story_key)
}

fn finish_with_basis(
    db: &Database,
    attempt_id: String,
    historical_scope_authority_basis: NarrativeScopeAuthorityBasisV2,
) -> anyhow::Result<serde_json::Value> {
    // This is the exact camelCase JSON decode used by the N-API
    // `agent_write_cmd` boundary. Keep it here so a wire-name drift cannot
    // silently turn the typed companion into `None` while finish still passes.
    let payload: FinishTaskPayload = serde_json::from_value(json!({
        "runId": RUN_ID,
        "projectId": PROJECT_ID,
        "taskId": TASK_ID,
        "attemptId": attempt_id,
        "leaseOwner": LEASE_OWNER,
        "outputJson": {"snapshotDigest": SNAPSHOT_DIGEST},
        "artifacts": [],
        "historicalScopeAuthorityBasis": historical_scope_authority_basis,
    }))
    .expect("decode typed finish wire payload");
    assert!(
        payload.historical_scope_authority_basis.is_some(),
        "wire payload must retain the typed historical companion"
    );
    narrative_extraction::narrative_extraction_finish_task(db, payload)
}

fn assert_finish_rolled_back(db: &Database) {
    db.with_conn(|conn| {
        let artifact_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_extraction_artifacts WHERE run_id = ?1",
            [RUN_ID],
            |row| row.get(0),
        )?;
        let task_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
            [TASK_ID],
            |row| row.get(0),
        )?;
        let attempt_status: String = conn.query_row(
            "SELECT status FROM narrative_extraction_attempts WHERE task_id = ?1",
            [TASK_ID],
            |row| row.get(0),
        )?;
        assert_eq!(artifact_count, 0);
        assert_eq!(task_status, "running");
        assert_eq!(attempt_status, "running");
        Ok(())
    })
    .expect("inspect atomic rollback");
}

#[test]
fn generic_finish_cannot_mint_the_reserved_scope_authority_carrier() {
    let db = fixture();
    let attempt_id = claim_attempt(&db);

    let error = narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: RUN_ID.to_owned(),
            project_id: PROJECT_ID.to_owned(),
            task_id: TASK_ID.to_owned(),
            attempt_id,
            lease_owner: LEASE_OWNER.to_owned(),
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
            historical_scope_authority_basis: None,
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

#[test]
fn typed_finish_rederives_persists_and_loads_the_historical_basis() {
    let db = fixture();
    let expected = basis("0010");
    finish_with_basis(&db, claim_attempt(&db), expected.clone()).expect("finish typed snapshot");

    db.with_conn(|conn| {
        let stored: (String, String, Option<String>, String) = conn.query_row(
            "SELECT artifact_kind, payload_storage, payload_ref, payload_digest
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1",
            [RUN_ID],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(stored.0, "source.snapshot@2");
        assert_eq!(stored.1, "inline-json");
        assert_eq!(stored.2, None);
        assert!(stored.3.starts_with("sha256:"));

        // Historical reads must not depend on mutable live tree state.
        conn.execute(
            "UPDATE tree_nodes SET story_time_order = 'changed-after-finish'
              WHERE id = 'scene-one'",
            [],
        )?;
        Ok(())
    })
    .expect("inspect and mutate live tree");

    let loaded =
        narrative_extraction::load_historical_scope_authority_basis(&db, PROJECT_ID, RUN_ID)
            .expect("load historical basis")
            .expect("stored basis");
    assert_eq!(loaded, expected);
}

#[test]
fn typed_finish_rolls_back_when_the_submitted_basis_differs_from_native_rederivation() {
    let db = fixture();
    let error = finish_with_basis(&db, claim_attempt(&db), basis("0099"))
        .expect_err("mismatched story authority must fail closed");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_BINDING_MISMATCH"),
        "unexpected error: {error}"
    );

    assert_finish_rolled_back(&db);
}

#[test]
fn typed_finish_rejects_valid_bases_bound_to_another_project_or_run() {
    for submitted in [
        basis_for("another-project", RUN_ID, "0010"),
        basis_for(PROJECT_ID, "another-run", "0010"),
    ] {
        let db = fixture();
        let error = finish_with_basis(&db, claim_attempt(&db), submitted)
            .expect_err("foreign basis binding must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_SCOPE_AUTHORITY_BINDING_MISMATCH"),
            "unexpected error: {error}"
        );
        assert_finish_rolled_back(&db);
    }
}

#[test]
fn typed_finish_rejects_current_scope_membership_and_order_drift() {
    for mutation in [
        "UPDATE tree_nodes SET archived_at = datetime('now') WHERE id = 'scene-two'",
        "UPDATE tree_nodes SET sort_order = CASE id
           WHEN 'scene-one' THEN 'a2' WHEN 'scene-two' THEN 'a0' ELSE sort_order END
         WHERE id IN ('scene-one', 'scene-two')",
    ] {
        let db = fixture();
        let submitted = basis("0010");
        let attempt_id = claim_attempt(&db);
        db.with_conn(|conn| {
            conn.execute(mutation, [])?;
            Ok(())
        })
        .expect("mutate durable tree after basis build");

        let error = finish_with_basis(&db, attempt_id, submitted)
            .expect_err("scope drift must fail closed");
        assert!(
            error
                .to_string()
                .contains("NEX_SCOPE_AUTHORITY_DURABLE_SCOPE_MISMATCH"),
            "unexpected error: {error}"
        );
        assert_finish_rolled_back(&db);
    }
}

#[test]
fn typed_finish_rejects_a_run_with_duplicate_snapshot_tasks() {
    let db = fixture();
    let attempt_id = claim_attempt(&db);
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority,
                 attempt_count, created_at, version)
             VALUES ('duplicate-snapshot-task', ?1, 'source.snapshot@1',
                     'queued', '{}', 0, 0, datetime('now'), 0)",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("seed corrupt duplicate snapshot task");

    let error = finish_with_basis(&db, attempt_id, basis("0010"))
        .expect_err("duplicate snapshot tasks must fail closed");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_TASK_INVALID"),
        "unexpected error: {error}"
    );
    assert_finish_rolled_back(&db);
}

#[test]
fn typed_finish_rejects_a_reclaimed_stale_attempt_even_with_the_same_lease_owner() {
    let db = fixture();
    let stale_attempt_id = claim_attempt(&db);
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_tasks
                SET lease_expires_at = '2000-01-01T00:00:00.000Z'
              WHERE id = ?1",
            [TASK_ID],
        )?;
        Ok(())
    })
    .expect("expire first task lease");
    let current_attempt_id = claim_attempt(&db);
    assert_ne!(stale_attempt_id, current_attempt_id);

    let error = finish_with_basis(&db, stale_attempt_id, basis("0010"))
        .expect_err("a displaced attempt must not finish the reclaimed task");
    assert!(
        error.to_string().contains("current running attempt"),
        "unexpected error: {error}"
    );
    assert_finish_rolled_back(&db);

    finish_with_basis(&db, current_attempt_id, basis("0010"))
        .expect("the latest attempt may finish the typed snapshot");
}

#[test]
fn typed_finish_handles_a_deep_valid_folder_chain_without_recursive_stack_growth() {
    const DEPTH: usize = 16_384;
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<()> {
            let mut statement = conn.prepare(
                "INSERT INTO tree_nodes
                    (id, project_id, parent_id, node_type, title, sort_order)
                 VALUES (?1, ?2, ?3, 'folder', 'Nested', 'a0')",
            )?;
            let mut parent_id = "folder-root".to_owned();
            for index in 0..DEPTH {
                let folder_id = format!("deep-folder-{index:05}");
                statement.execute((&folder_id, PROJECT_ID, &parent_id))?;
                parent_id = folder_id;
            }
            drop(statement);
            conn.execute(
                "UPDATE tree_nodes SET parent_id = ?1 WHERE id = 'scene-one'",
                [&parent_id],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => grimodex_core::commit_or_rollback(conn),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
    .expect("seed deep durable folder chain");

    finish_with_basis(&db, claim_attempt(&db), basis("0010"))
        .expect("iterative durable traversal must finish the deep scope");
}

#[test]
fn historical_reader_rejects_corrupted_payloads() {
    let db = fixture();
    finish_with_basis(&db, claim_attempt(&db), basis("0010")).expect("finish typed snapshot");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_artifacts SET payload_json = '{'
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@2'",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("corrupt stored payload");

    let error =
        narrative_extraction::load_historical_scope_authority_basis(&db, PROJECT_ID, RUN_ID)
            .expect_err("corrupt historical payload must fail closed");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_ARTIFACT_INVALID"),
        "unexpected error: {error}"
    );
}

#[test]
fn historical_reader_binds_document_coverage_to_the_durable_run_scope() {
    let db = fixture();
    finish_with_basis(&db, claim_attempt(&db), basis("0010")).expect("finish typed snapshot");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET scope_json = '{\"folderId\":\"folder-root\",\"sceneIds\":[\"scene-two\",\"scene-one\"]}'
              WHERE id = ?1",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("corrupt durable Run scope");

    let error =
        narrative_extraction::load_historical_scope_authority_basis(&db, PROJECT_ID, RUN_ID)
            .expect_err("artifact coverage must bind exact durable Run scope order");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_SCOPE_MISMATCH"),
        "unexpected error: {error}"
    );
}

#[test]
fn historical_reader_rejects_duplicate_reserved_artifacts() {
    let db = fixture();
    finish_with_basis(&db, claim_attempt(&db), basis("0010")).expect("finish typed snapshot");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind, payload_storage,
                 payload_json, payload_ref, payload_digest, created_at)
             SELECT 'duplicate-scope-authority', run_id, task_id, attempt_id,
                    artifact_kind, payload_storage, payload_json, payload_ref,
                    payload_digest, created_at
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1 AND artifact_kind = 'source.snapshot@2'",
            [RUN_ID],
        )?;
        Ok(())
    })
    .expect("duplicate stored payload");

    let error =
        narrative_extraction::load_historical_scope_authority_basis(&db, PROJECT_ID, RUN_ID)
            .expect_err("duplicate historical artifacts must fail closed");
    assert!(
        error.to_string().contains("NEX_SCOPE_AUTHORITY_DUPLICATE"),
        "unexpected error: {error}"
    );
}

#[test]
fn historical_reader_rejects_a_second_completed_snapshot_attempt() {
    let db = fixture();
    finish_with_basis(&db, claim_attempt(&db), basis("0010")).expect("finish typed snapshot");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at, completed_at)
             VALUES ('duplicate-completed-attempt', ?1, 2, 'completed',
                     datetime('now'), datetime('now'))",
            [TASK_ID],
        )?;
        Ok(())
    })
    .expect("seed corrupt duplicate completed attempt");

    let error =
        narrative_extraction::load_historical_scope_authority_basis(&db, PROJECT_ID, RUN_ID)
            .expect_err("duplicate completed attempts must fail closed");
    assert!(
        error
            .to_string()
            .contains("NEX_SCOPE_AUTHORITY_ATTEMPT_INVALID"),
        "unexpected error: {error}"
    );
}
