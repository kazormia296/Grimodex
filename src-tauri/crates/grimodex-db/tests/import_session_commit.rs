use grimodex_db::import::{
    apply_commit, create_session, save_source_package, ImportApplyCommitPayload,
    ImportSessionCreatePayload, SaveImportSourcePackagePayload,
};
use grimodex_db::Database;
use grimodex_db::{
    load_narrative_runtime_policy_from_db, set_narrative_runtime_policy,
    SetNarrativeRuntimePolicyInput,
};
use rusqlite::OptionalExtension;
use serde_json::json;

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db
}

fn enable_generic_import_apply(db: &Database) {
    let before = load_narrative_runtime_policy_from_db(db).expect("load runtime policy");
    set_narrative_runtime_policy(
        db,
        SetNarrativeRuntimePolicyInput {
            expected_version: before.version,
            runtime_mode: "manual-apply".to_string(),
            maintenance_enabled: false,
            generic_import_enabled: true,
            background_ai_enabled: false,
        },
    )
    .expect("enable generic import apply");
}

fn create_ready_session(db: &Database, session_id: &str, project_id: &str) {
    enable_generic_import_apply(db);
    create_session(
        db,
        ImportSessionCreatePayload {
            session_id: Some(session_id.to_string()),
            adapter_id: Some("fixture-adapter".to_string()),
            adapter_version: Some("1.0.0".to_string()),
            target_json: json!({
                "kind": "new-project",
                "projectId": project_id,
                "title": "Imported novel",
                "language": "en"
            }),
        },
    )
    .expect("create import session");
    save_source_package(
        db,
        SaveImportSourcePackagePayload {
            session_id: session_id.to_string(),
            package_id: Some(format!("{session_id}-package")),
            digest: "package-digest".to_string(),
            adapter_id: "fixture-adapter".to_string(),
            adapter_version: "1.0.0".to_string(),
            package_json: json!({ "documents": [] }),
        },
    )
    .expect("save source package");
}

fn apply_payload(session_id: &str, request_id: &str, project_id: &str) -> ImportApplyCommitPayload {
    ImportApplyCommitPayload {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        plan_digest: "package-digest".to_string(),
        reserved_project_id: project_id.to_string(),
    }
}

#[test]
fn apply_creates_project_and_commits_session() {
    let db = migrated_db();
    create_ready_session(&db, "session-1", "imported-project");

    let receipt =
        apply_commit(&db, apply_payload("session-1", "request-1", "imported-project"))
            .expect("apply import commit");

    assert_eq!(receipt["status"], "committed");
    assert_eq!(receipt["projectId"], "imported-project");
    db.with_conn(|conn| {
        let state: String = conn.query_row(
            "SELECT state FROM import_sessions WHERE id = 'session-1'",
            [],
            |row| row.get(0),
        )?;
        let project: (String, String) = conn.query_row(
            "SELECT title, language FROM projects WHERE id = 'imported-project'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let commits: i64 = conn.query_row(
            "SELECT COUNT(*) FROM import_commits WHERE session_id = 'session-1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(state, "committed");
        assert_eq!(project, ("Imported novel".to_string(), "en".to_string()));
        assert_eq!(commits, 1);
        Ok(())
    })
    .expect("inspect committed import");
}

#[test]
fn request_id_replay_does_not_duplicate_project() {
    let db = migrated_db();
    create_ready_session(&db, "session-1", "imported-project");
    let payload = apply_payload("session-1", "request-1", "imported-project");

    let first = apply_commit(&db, payload.clone()).expect("first apply");
    let replay = apply_commit(&db, payload).expect("replay apply");

    assert_eq!(first["projectId"], replay["projectId"]);
    assert_eq!(replay["idempotentReplay"], true);
    db.with_conn(|conn| {
        let projects: i64 =
            conn.query_row("SELECT COUNT(*) FROM projects WHERE id = 'imported-project'", [], |row| {
                row.get(0)
            })?;
        assert_eq!(projects, 1);
        Ok(())
    })
    .expect("inspect replay");
}

#[test]
fn reserved_project_collision_rolls_back_session_commit() {
    let db = migrated_db();
    create_ready_session(&db, "session-1", "reserved-project");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('reserved-project', 'Existing project')",
            [],
        )?;
        Ok(())
    })
    .expect("reserve project id");

    let error = apply_commit(
        &db,
        apply_payload("session-1", "request-1", "reserved-project"),
    )
    .expect_err("collision must fail");
    assert!(error.to_string().contains("already exists"));

    db.with_conn(|conn| {
        let state: String = conn.query_row(
            "SELECT state FROM import_sessions WHERE id = 'session-1'",
            [],
            |row| row.get(0),
        )?;
        let commit: Option<String> = conn
            .query_row(
                "SELECT id FROM import_commits WHERE request_id = 'request-1'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        assert_eq!(state, "source-saved");
        assert_eq!(commit, None);
        Ok(())
    })
    .expect("inspect rollback");
}
