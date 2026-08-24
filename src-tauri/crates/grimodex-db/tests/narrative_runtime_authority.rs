//! Release Gate B Foundation — Narrative runtime authority integration.

use grimodex_db::import::{apply_commit, CreateCaptureInput, ImportApplyCommitPayload};
use grimodex_db::narrative_extraction::{
    self, ClaimTaskPayload, CreateRunPayload, CreateTaskSeed, FailTaskPayload, FinishTaskPayload,
    RunRefPayload,
};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, require_manual_apply_authority_in_tx,
    require_narrative_apply_allowed, require_narrative_extraction_allowed,
    require_narrative_redo_allowed, require_narrative_undo_allowed, set_narrative_runtime_policy,
    Database, NarrativeRuntimeMode, SetNarrativeRuntimePolicyInput, NARRATIVE_APPROVAL_REQUIRED,
    NARRATIVE_ENGINE_DISABLED, NARRATIVE_GENERIC_IMPORT_DISABLED, NARRATIVE_REVIEW_ONLY,
};
use serde_json::json;

fn runtime_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn create_run_with_task(db: &Database, run_id: &str, task_id: &str) {
    narrative_extraction::narrative_extraction_create_run(
        db,
        CreateRunPayload {
            run_id: Some(run_id.into()),
            project_id: "project-1".into(),
            surface_path_id: "chronicle.extract".into(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: format!("digest-{run_id}"),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![CreateTaskSeed {
                task_id: Some(task_id.into()),
                task_kind: "extract_window".into(),
                input_json: Some(json!({})),
                priority: None,
            }],
        },
    )
    .expect("create run");
}

fn claim_task(db: &Database, run_id: &str, lease_owner: &str) -> String {
    let claimed = narrative_extraction::narrative_extraction_claim_task(
        db,
        ClaimTaskPayload {
            run_id: run_id.into(),
            project_id: "project-1".into(),
            lease_owner: lease_owner.into(),
            lease_duration_secs: Some(300),
            task_kinds: None,
        },
    )
    .expect("claim task");
    assert_eq!(claimed["claimed"], true);
    claimed["task"]["attemptId"]
        .as_str()
        .expect("attempt id")
        .to_string()
}

fn disable_runtime(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("load policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "disabled".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("disable runtime");
}

fn assert_task_terminal_and_lease_released(db: &Database, task_id: &str, status: &str) {
    let state = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status, lease_owner, lease_expires_at, heartbeat_at
                   FROM narrative_extraction_tasks
                  WHERE id = ?1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )?)
        })
        .expect("load task state");
    assert_eq!(state.0, status);
    assert_eq!(state.1, None, "lease owner must be released");
    assert_eq!(state.2, None, "lease expiry must be released");
    assert_eq!(state.3, None, "heartbeat must be released");
}

fn assert_run_status(db: &Database, run_id: &str, status: &str) {
    let actual = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )?)
        })
        .expect("load run status");
    assert_eq!(actual, status);
}

#[test]
fn workspace_defaults_block_apply_and_allow_undo() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
    assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);

    db.with_conn(|conn| {
        let err = require_narrative_apply_allowed(conn).expect_err("apply denied");
        assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
        require_narrative_undo_allowed(conn).expect("undo allowed");
        let err = require_narrative_redo_allowed(conn).expect_err("redo denied");
        assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
        Ok(())
    })
    .expect("conn");
}

#[test]
fn create_run_is_denied_when_runtime_is_disabled() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let before = load_narrative_runtime_policy_from_db(&db).expect("load");
    set_narrative_runtime_policy(
        &db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "disabled".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("set disabled");

    let error = narrative_extraction::narrative_extraction_create_run(
        &db,
        CreateRunPayload {
            run_id: Some("denied-run".into()),
            project_id: "project-1".into(),
            surface_path_id: "chronicle.extract".into(),
            scope_json: json!({}),
            spec_json: json!({}),
            spec_digest: "digest".into(),
            snapshot_digest: None,
            catalog_digest: None,
            registry_digest: None,
            coverage_json: None,
            tasks: vec![],
        },
    )
    .expect_err("create_run must be denied");
    assert!(error.to_string().contains(NARRATIVE_ENGINE_DISABLED));
}

#[test]
fn disabled_runtime_still_allows_in_flight_work_to_terminalize_and_release_leases() {
    let db = runtime_db();
    create_run_with_task(&db, "run-finish", "task-finish");
    create_run_with_task(&db, "run-fail", "task-fail");
    create_run_with_task(&db, "run-cancel", "task-cancel");
    create_run_with_task(&db, "run-claim-blocked", "task-claim-blocked");

    let finish_attempt = claim_task(&db, "run-finish", "worker-finish");
    let fail_attempt = claim_task(&db, "run-fail", "worker-fail");
    let _cancel_attempt = claim_task(&db, "run-cancel", "worker-cancel");

    disable_runtime(&db);

    let claim_error = narrative_extraction::narrative_extraction_claim_task(
        &db,
        ClaimTaskPayload {
            run_id: "run-claim-blocked".into(),
            project_id: "project-1".into(),
            lease_owner: "worker-blocked".into(),
            lease_duration_secs: Some(300),
            task_kinds: None,
        },
    )
    .expect_err("disabled runtime must reject new claims");
    assert!(claim_error.to_string().contains(NARRATIVE_ENGINE_DISABLED));

    narrative_extraction::narrative_extraction_finish_task(
        &db,
        FinishTaskPayload {
            run_id: "run-finish".into(),
            project_id: "project-1".into(),
            task_id: "task-finish".into(),
            attempt_id: finish_attempt,
            lease_owner: "worker-finish".into(),
            output_json: Some(json!({ "ok": true })),
            artifacts: vec![],
            chronicle_stage_bundle: None,
        },
    )
    .expect("finish in-flight task after disable");

    narrative_extraction::narrative_extraction_fail_task(
        &db,
        FailTaskPayload {
            run_id: "run-fail".into(),
            project_id: "project-1".into(),
            task_id: "task-fail".into(),
            attempt_id: fail_attempt,
            lease_owner: "worker-fail".into(),
            error_message: "worker stopped after policy change".into(),
            output_json: None,
            requeue: Some(false),
        },
    )
    .expect("fail in-flight task after disable");

    narrative_extraction::narrative_extraction_cancel_run(
        &db,
        RunRefPayload {
            run_id: "run-cancel".into(),
            project_id: "project-1".into(),
        },
    )
    .expect("cancel in-flight run after disable");

    assert_task_terminal_and_lease_released(&db, "task-finish", "completed");
    assert_run_status(&db, "run-finish", "completed");
    assert_task_terminal_and_lease_released(&db, "task-fail", "failed");
    assert_run_status(&db, "run-fail", "failed");
    assert_task_terminal_and_lease_released(&db, "task-cancel", "cancelled");
    assert_run_status(&db, "run-cancel", "cancelled");
}

#[test]
fn import_capture_is_denied_when_generic_import_is_disabled() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");

    let error = grimodex_db::import::create_capture(
        &db,
        CreateCaptureInput {
            capture_id: Some("denied-capture".into()),
            source_kind: "folder".into(),
            budget_json: json!({}),
            entries: vec![],
        },
    )
    .expect_err("capture must be denied");
    assert!(error
        .to_string()
        .contains(NARRATIVE_GENERIC_IMPORT_DISABLED));
}

#[test]
fn import_apply_is_denied_in_review_only_even_when_capture_is_enabled() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let before = load_narrative_runtime_policy_from_db(&db).expect("load");
    set_narrative_runtime_policy(
        &db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "review-only".into(),
            maintenance_enabled: false,
            generic_import_enabled: true,
            background_ai_enabled: false,
        },
    )
    .expect("enable generic import capture");

    let error = apply_commit(
        &db,
        ImportApplyCommitPayload {
            session_id: "missing-session".into(),
            request_id: "request-1".into(),
            plan_digest: "digest".into(),
            reserved_project_id: "project-1".into(),
        },
    )
    .expect_err("import apply must be denied");
    assert!(error.to_string().contains(NARRATIVE_REVIEW_ONLY));
}

#[test]
fn disabled_mode_blocks_extraction_entrypoints() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let before = load_narrative_runtime_policy_from_db(&db).expect("load");
    set_narrative_runtime_policy(
        &db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "disabled".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("set");
    db.with_conn(|conn| {
        let err = require_narrative_extraction_allowed(conn).expect_err("disabled");
        assert!(err.to_string().contains(NARRATIVE_ENGINE_DISABLED));
        Ok(())
    })
    .expect("conn");
}

#[test]
fn renderer_sql_cannot_promote_runtime_mode_to_automatic() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");

    let error = db
        .execute_renderer(
            "UPDATE narrative_runtime_policy
                SET runtime_mode = 'automatic'
              WHERE singleton_id = 1",
            &[],
            "run",
        )
        .expect_err("renderer blocked");
    assert!(error.to_string().contains("PROTECTED_WRITER_SQL"));

    // Legacy app_settings shadow writes must not become authority either.
    let _ = db.execute_renderer(
        "INSERT OR REPLACE INTO app_settings (key, value)
         VALUES ('narrative.runtimeMode', 'automatic')",
        &[],
        "run",
    );
    let policy = load_narrative_runtime_policy_from_db(&db).expect("load");
    assert_eq!(policy.runtime_mode, NarrativeRuntimeMode::ReviewOnly);
    db.with_conn(|conn| {
        let err = require_narrative_apply_allowed(conn).expect_err("still review-only");
        assert!(err.to_string().contains(NARRATIVE_REVIEW_ONLY));
        Ok(())
    })
    .expect("conn");
}

#[test]
fn raw_apply_without_db_decision_is_rejected() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let before = load_narrative_runtime_policy_from_db(&db).expect("load");
    set_narrative_runtime_policy(
        &db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".into(),
            maintenance_enabled: false,
            generic_import_enabled: false,
            background_ai_enabled: false,
        },
    )
    .expect("set");
    db.with_conn(|conn| {
        let err = require_manual_apply_authority_in_tx(conn, "ps", "prop", "rev")
            .expect_err("proposal missing");
        assert!(err.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
        Ok(())
    })
    .expect("conn");
}
