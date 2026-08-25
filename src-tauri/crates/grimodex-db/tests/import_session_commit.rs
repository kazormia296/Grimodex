use grimodex_db::import::{
    apply_commit, create_session, save_source_package, ImportApplyCommitPayload,
    ImportSessionCreatePayload, SaveImportSourcePackagePayload,
};
use grimodex_db::narrative_extraction::{
    C2_ZC_CUTOVER_CONTRACT_VERSION, C2_ZC_CUTOVER_MIGRATION_ID,
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

    let receipt = apply_commit(
        &db,
        apply_payload("session-1", "request-1", "imported-project"),
    )
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
        let feed: (String, String, i64) = conn.query_row(
            "SELECT origin, source_domain,
                    (SELECT COUNT(*) FROM narrative_change_events
                      WHERE project_id = 'imported-project')
               FROM narrative_change_transactions
              WHERE project_id = 'imported-project'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(state, "committed");
        assert_eq!(project, ("Imported novel".to_string(), "en".to_string()));
        assert_eq!(commits, 1);
        assert_eq!(
            feed,
            ("import".to_string(), "import.session.apply".to_string(), 5)
        );
        let epoch_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'imported-project'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(epoch_count, 0, "pre-marker import must not mint an Epoch");
        let feed_order = conn
            .prepare(
                "SELECT event.event_ordinal,
                        json_extract(event.object_key_json, '$.kind'),
                        coalesce(json_extract(event.object_key_json, '$.componentId'), '')
                   FROM narrative_change_events event
                  WHERE event.project_id = 'imported-project'
                  ORDER BY event.event_ordinal",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            feed_order,
            vec![
                (0, "import-source".to_string(), "".to_string()),
                (
                    1,
                    "component".to_string(),
                    "codex-type:imported-project-character".to_string(),
                ),
                (
                    2,
                    "component".to_string(),
                    "codex-type:imported-project-location".to_string(),
                ),
                (
                    3,
                    "component".to_string(),
                    "codex-type:imported-project-item".to_string(),
                ),
                (
                    4,
                    "component".to_string(),
                    "codex-type:imported-project-lore".to_string(),
                ),
            ]
        );
        Ok(())
    })
    .expect("inspect committed import");
}

#[test]
fn post_marker_import_binds_one_initial_epoch_to_the_import_apply_event() {
    let db = migrated_db();
    create_ready_session(&db, "session-c2zc-birth", "imported-c2zc-project");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                C2_ZC_CUTOVER_MIGRATION_ID,
                C2_ZC_CUTOVER_CONTRACT_VERSION,
                "2026-08-25T00:00:00.000Z",
            ],
        )?;
        Ok(())
    })
    .expect("activate C2-ZC marker fixture");

    let payload = apply_payload(
        "session-c2zc-birth",
        "request-c2zc-birth",
        "imported-c2zc-project",
    );
    let first = apply_commit(&db, payload.clone()).expect("apply post-marker import");
    let replay = apply_commit(&db, payload).expect("replay post-marker import");
    assert_eq!(replay["idempotentReplay"], true);
    assert_eq!(first["projectId"], replay["projectId"]);

    db.with_conn(|conn| {
        let event_uid: String = conn.query_row(
            "SELECT event_uid FROM change_events
              WHERE project_id = 'imported-c2zc-project'
                AND domain = 'import'
                AND op_type = 'import.session.apply'
                AND entity_type = 'import_session'
                AND entity_id = 'session-c2zc-birth'",
            [],
            |row| row.get(0),
        )?;
        let epochs = conn
            .prepare(
                "SELECT epoch_number, reason, triggered_by_change_event_uid
                   FROM narrative_semantic_epochs
                  WHERE project_id = 'imported-c2zc-project'
                  ORDER BY epoch_number ASC",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            epochs,
            vec![(0, "initial".to_string(), Some(event_uid))],
            "the imported project birth must be bound to its canonical Import Apply event"
        );
        Ok(())
    })
    .expect("verify post-marker import Epoch");
}

#[test]
fn import_fails_atomically_for_an_unsupported_c2zc_marker() {
    let db = migrated_db();
    create_ready_session(&db, "session-c2zc-unsupported", "imported-c2zc-unsupported");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
             VALUES (?1, ?2, ?3)",
            rusqlite::params![
                C2_ZC_CUTOVER_MIGRATION_ID,
                C2_ZC_CUTOVER_CONTRACT_VERSION + 1,
                "2026-08-25T00:00:00.000Z",
            ],
        )?;
        Ok(())
    })
    .expect("seed unsupported C2-ZC marker fixture");

    let error = apply_commit(
        &db,
        apply_payload(
            "session-c2zc-unsupported",
            "request-c2zc-unsupported",
            "imported-c2zc-unsupported",
        ),
    )
    .expect_err("unsupported marker must reject import before it commits");
    assert!(error
        .to_string()
        .contains("NEX_C2ZC_IMPORT_PROJECT_BIRTH_MARKER_UNSUPPORTED"));

    db.with_conn(|conn| {
        let state: String = conn.query_row(
            "SELECT state FROM import_sessions WHERE id = 'session-c2zc-unsupported'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(state, "source-saved");
        for (label, sql) in [
            (
                "import project",
                "SELECT COUNT(*) FROM projects WHERE id = 'imported-c2zc-unsupported'",
            ),
            (
                "import receipt",
                "SELECT COUNT(*) FROM import_commits WHERE request_id = 'request-c2zc-unsupported'",
            ),
            (
                "canonical event",
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'imported-c2zc-unsupported'",
            ),
            (
                "Feed transaction",
                "SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = 'imported-c2zc-unsupported'",
            ),
            (
                "birth Epoch",
                "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'imported-c2zc-unsupported'",
            ),
        ] {
            let count: i64 = conn.query_row(sql, [], |row| row.get(0))?;
            assert_eq!(count, 0, "{label} must roll back");
        }
        Ok(())
    })
    .expect("verify unsupported-marker import rollback");
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
        let projects: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE id = 'imported-project'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(projects, 1);
        let canonical: i64 = conn.query_row(
            "SELECT COUNT(*) FROM change_events
              WHERE project_id = 'imported-project' AND op_type = 'import.session.apply'",
            [],
            |row| row.get(0),
        )?;
        let feed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_change_transactions
              WHERE project_id = 'imported-project' AND source_domain = 'import.session.apply'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!((canonical, feed), (1, 1));
        Ok(())
    })
    .expect("inspect replay");
}

#[test]
fn request_id_replay_is_bound_to_session_digest_and_reserved_project() {
    let db = migrated_db();
    create_ready_session(&db, "session-1", "imported-project-1");
    create_ready_session(&db, "session-2", "imported-project-2");

    apply_commit(
        &db,
        apply_payload("session-1", "shared-request", "imported-project-1"),
    )
    .expect("first apply");

    let error = apply_commit(
        &db,
        apply_payload("session-2", "shared-request", "imported-project-2"),
    )
    .expect_err("request identity must not replay another import authority");
    assert!(error
        .to_string()
        .contains("IMPORT_COMMIT_IDEMPOTENCY_CONFLICT"));

    db.with_conn(|conn| {
        let second_project: i64 = conn.query_row(
            "SELECT COUNT(*) FROM projects WHERE id = 'imported-project-2'",
            [],
            |row| row.get(0),
        )?;
        let second_state: String = conn.query_row(
            "SELECT state FROM import_sessions WHERE id = 'session-2'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(second_project, 0);
        assert_eq!(second_state, "source-saved");
        Ok(())
    })
    .expect("inspect request authority conflict");
}

#[test]
fn feed_failure_rolls_back_import_project_session_and_receipt() {
    let db = migrated_db();
    create_ready_session(&db, "session-feed-failure", "failed-import-project");
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER fail_import_feed
               BEFORE INSERT ON narrative_change_transactions
               WHEN NEW.source_domain = 'import.session.apply'
             BEGIN
               SELECT RAISE(ABORT, 'forced import feed failure');
             END;",
        )?;
        Ok(())
    })
    .expect("install Feed failure");

    let error = apply_commit(
        &db,
        apply_payload(
            "session-feed-failure",
            "request-feed-failure",
            "failed-import-project",
        ),
    )
    .expect_err("Feed failure must abort import apply");
    assert!(error.to_string().contains("forced import feed failure"));

    db.with_conn(|conn| {
        let state: String = conn.query_row(
            "SELECT state FROM import_sessions WHERE id = 'session-feed-failure'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(state, "source-saved");
        for (label, sql) in [
            (
                "import project",
                "SELECT COUNT(*) FROM projects WHERE id = 'failed-import-project'",
            ),
            (
                "import receipt",
                "SELECT COUNT(*) FROM import_commits WHERE request_id = 'request-feed-failure'",
            ),
            (
                "canonical event",
                "SELECT COUNT(*) FROM change_events WHERE op_type = 'import.session.apply'",
            ),
            (
                "Feed transaction",
                "SELECT COUNT(*) FROM narrative_change_transactions WHERE source_domain = 'import.session.apply'",
            ),
            (
                "Feed event",
                "SELECT COUNT(*) FROM narrative_change_events WHERE project_id = 'failed-import-project'",
            ),
        ] {
            let count: i64 = conn.query_row(sql, [], |row| row.get(0))?;
            assert_eq!(count, 0, "{label} must roll back");
        }
        Ok(())
    })
    .expect("verify import rollback");
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
