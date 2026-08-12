//! Release Gate B Foundation — Narrative runtime authority integration.

use grimodex_db::import::{apply_commit, CreateCaptureInput, ImportApplyCommitPayload};
use grimodex_db::narrative_extraction::{self, CreateRunPayload};
use grimodex_db::{
    load_narrative_runtime_policy_from_db, require_manual_apply_authority_in_tx,
    require_narrative_apply_allowed, require_narrative_extraction_allowed,
    require_narrative_redo_allowed, require_narrative_undo_allowed, set_narrative_runtime_policy,
    Database, NarrativeRuntimeMode, SetNarrativeRuntimePolicyInput, NARRATIVE_APPROVAL_REQUIRED,
    NARRATIVE_ENGINE_DISABLED, NARRATIVE_GENERIC_IMPORT_DISABLED, NARRATIVE_REVIEW_ONLY,
};
use serde_json::json;

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
    assert!(error.to_string().contains(NARRATIVE_GENERIC_IMPORT_DISABLED));
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
