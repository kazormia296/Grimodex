//! Release Gate B Foundation — Narrative runtime authority integration.

use grimodex_db::{
    load_narrative_runtime_policy_from_db, require_manual_apply_authority_in_tx,
    require_narrative_apply_allowed, require_narrative_extraction_allowed,
    require_narrative_undo_allowed, set_narrative_runtime_policy, Database, NarrativeRuntimeMode,
    SetNarrativeRuntimePolicyInput, NARRATIVE_APPROVAL_REQUIRED, NARRATIVE_ENGINE_DISABLED,
    NARRATIVE_REVIEW_ONLY,
};

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
        Ok(())
    })
    .expect("conn");
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
        let err = require_manual_apply_authority_in_tx(conn, "ps", "rev")
            .expect_err("approval tables missing");
        assert!(err.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
        Ok(())
    })
    .expect("conn");
}
