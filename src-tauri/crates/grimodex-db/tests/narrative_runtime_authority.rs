//! Release Gate B — Narrative runtime authority / SQL protection integration.

use grimodex_db::narrative_runtime_policy::SETTING_RUNTIME_MODE;
use grimodex_db::{
    load_narrative_runtime_policy_from_db, require_manual_apply_authority,
    require_narrative_apply_allowed, require_narrative_extraction_allowed,
    require_narrative_undo_allowed, ManualApplyAuthority, NarrativeRuntimeMode, Database,
    NARRATIVE_APPROVAL_REQUIRED, NARRATIVE_ENGINE_DISABLED, NARRATIVE_REVIEW_ONLY,
};

fn write_setting(db: &Database, key: &str, value: &str) {
    db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        &[serde_json::Value::from(key), serde_json::Value::from(value)],
        "run",
    )
    .expect("write setting");
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
        Ok(())
    })
    .expect("conn");
}

#[test]
fn disabled_mode_blocks_extraction_entrypoints() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    write_setting(&db, SETTING_RUNTIME_MODE, "disabled");
    db.with_conn(|conn| {
        let err = require_narrative_extraction_allowed(conn).expect_err("disabled");
        assert!(err.to_string().contains(NARRATIVE_ENGINE_DISABLED));
        Ok(())
    })
    .expect("conn");
}

#[test]
fn raw_apply_without_approval_is_rejected_even_in_manual_apply() {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    write_setting(&db, SETTING_RUNTIME_MODE, "manual-apply");
    let authority = ManualApplyAuthority {
        proposal_set_id: "ps".into(),
        expected_revision_id: "rev-1".into(),
        current_revision_id: "rev-1".into(),
        latest_decision_status: "pending".into(),
        decision_revision_id: "rev-1".into(),
    };
    db.with_conn(|conn| {
        let err = require_manual_apply_authority(conn, &authority).expect_err("approval");
        assert!(err.to_string().contains(NARRATIVE_APPROVAL_REQUIRED));
        Ok(())
    })
    .expect("conn");
}
