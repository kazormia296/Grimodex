use grimodex_db::{foreshadow, plot_threads, Database};
use serde_json::{json, Value};

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES
                ('project-a', 'Project A'),
                ('project-b', 'Project B');
             INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES
                ('scene-a', 'project-a', 'scene', 'Scene A'),
                ('scene-b', 'project-b', 'scene', 'Scene B');",
        )?;
        Ok(())
    })
    .expect("seed projects");
    db
}

fn count(db: &Database, table: &str) -> i64 {
    db.with_conn(|conn| {
        let sql = format!("SELECT COUNT(*) FROM {table}");
        conn.query_row(&sql, [], |row| row.get(0))
            .map_err(Into::into)
    })
    .expect("count rows")
}

fn plot_thread_payload(id: &str) -> plot_threads::PlotThreadCreatePayload {
    plot_thread_payload_with_transport(id, "renderer-session", &format!("event-{id}"))
}

fn plot_thread_payload_with_transport(
    id: &str,
    session_id: &str,
    event_uid: &str,
) -> plot_threads::PlotThreadCreatePayload {
    serde_json::from_value(json!({
        "id": id,
        "requestId": format!("request-{id}"),
        "sessionId": session_id,
        "eventUid": event_uid,
        "origin": "human",
        "projectId": "project-a",
        "name": id,
        "sortOrder": "a0"
    }))
    .expect("plot thread payload")
}

#[test]
fn plot_create_rolls_back_domain_canonical_and_request_ledger_when_feed_fails() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TEMP TRIGGER reject_plot_feed
             BEFORE INSERT ON narrative_change_events
             BEGIN
               SELECT RAISE(ABORT, 'forced Feed failure');
             END;",
        )?;
        Ok(())
    })
    .expect("install failure trigger");

    let error = plot_threads::create(&db, plot_thread_payload("thread-rollback"))
        .expect_err("Feed failure must abort the writer transaction");
    assert!(error.to_string().contains("forced Feed failure"));
    assert_eq!(count(&db, "plot_threads"), 0);
    assert_eq!(count(&db, "change_events"), 0);
    assert_eq!(count(&db, "narrative_change_transactions"), 0);
    assert_eq!(count(&db, "idempotency_requests"), 0);
}

#[test]
fn plot_create_retry_reuses_one_canonical_and_feed_transaction() {
    let db = migrated_db();

    plot_threads::create(&db, plot_thread_payload("thread-retry")).expect("first create");
    plot_threads::create(
        &db,
        plot_thread_payload_with_transport(
            "thread-retry",
            "renderer-retry-session",
            "event-thread-retry-transport",
        ),
    )
    .expect("cross-session retry create");

    assert_eq!(count(&db, "plot_threads"), 1);
    assert_eq!(count(&db, "change_events"), 1);
    assert_eq!(count(&db, "narrative_change_transactions"), 1);
    assert_eq!(count(&db, "narrative_change_events"), 1);
    let identity: (String, String, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT event.event_uid, event.session_id, tx.request_id
                   FROM change_events event
                   JOIN narrative_change_transactions tx
                     ON tx.project_id = event.project_id
                    AND tx.source_change_event_uid = event.event_uid",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("load writer identity");
    assert_eq!(
        identity,
        (
            "event-thread-retry".to_string(),
            "renderer-session".to_string(),
            "request-thread-retry".to_string(),
        )
    );
}

fn seed_plot_roots(db: &Database) {
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO plot_threads (id, project_id, name, sort_order) VALUES
                ('z-thread', 'project-a', 'Z', 'a0'),
                ('a-thread', 'project-a', 'A', 'a1'),
                ('foreign-thread', 'project-b', 'Foreign', 'a0');",
        )?;
        Ok(())
    })
    .expect("seed plot roots");
}

#[test]
fn plot_branch_rejects_cross_project_roots_before_any_ledger_append() {
    let db = migrated_db();
    seed_plot_roots(&db);
    let payload = serde_json::from_value(json!({
        "id": "branch-cross-project",
        "requestId": "request-branch-cross-project",
        "sessionId": "renderer-session",
        "eventUid": "event-branch-cross-project",
        "origin": "human",
        "projectId": "project-a",
        "fromThreadId": "z-thread",
        "toThreadId": "foreign-thread",
        "atNodeId": "scene-a",
        "kind": "branch"
    }))
    .expect("branch payload");

    plot_threads::branch_create(&db, payload).expect_err("cross-project branch must fail");
    assert_eq!(count(&db, "plot_thread_branches"), 0);
    assert_eq!(count(&db, "change_events"), 0);
    assert_eq!(count(&db, "narrative_change_transactions"), 0);
}

#[test]
fn plot_branch_feed_identifies_the_mutated_component_once() {
    let db = migrated_db();
    seed_plot_roots(&db);
    let payload = serde_json::from_value(json!({
        "id": "branch-order",
        "requestId": "request-branch-order",
        "sessionId": "renderer-session",
        "eventUid": "event-branch-order",
        "origin": "human",
        "projectId": "project-a",
        "fromThreadId": "z-thread",
        "toThreadId": "a-thread",
        "atNodeId": "scene-a",
        "kind": "branch"
    }))
    .expect("branch payload");

    plot_threads::branch_create(&db, payload).expect("create branch");
    let roots = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT object_key_json, changed_paths_json
                   FROM narrative_change_events
                  ORDER BY event_ordinal",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .expect("load Feed events");

    assert_eq!(roots.len(), 1);
    let object_key: Value = serde_json::from_str(&roots[0].0).expect("object key");
    assert_eq!(
        object_key,
        json!({
            "kind": "plot-branch",
            "branchId": "branch-order",
        })
    );
    let paths: Value = serde_json::from_str(&roots[0].1).expect("changed paths");
    assert_eq!(paths, json!(["/"]));
}

#[test]
fn foreshadow_create_emits_one_root_aggregate_event() {
    let db = migrated_db();
    let payload = serde_json::from_value(json!({
        "id": "foreshadow-1",
        "requestId": "request-foreshadow-1",
        "sessionId": "renderer-session",
        "eventUid": "event-foreshadow-1",
        "origin": "human",
        "projectId": "project-a",
        "title": "Promise"
    }))
    .expect("foreshadow payload");

    foreshadow::create(&db, payload).expect("create foreshadow");
    let event: (String, String, String) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT object_key_json, mutation_kind, changed_paths_json
                   FROM narrative_change_events",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("load Feed event");
    assert_eq!(
        serde_json::from_str::<Value>(&event.0).expect("object key"),
        json!({ "kind": "foreshadow", "foreshadowId": "foreshadow-1" })
    );
    assert_eq!(event.1, "create");
    assert_eq!(
        serde_json::from_str::<Value>(&event.2).expect("paths"),
        json!(["/"])
    );
}

fn foreshadow_payload(
    id: &str,
    project_id: &str,
    request_id: &str,
) -> foreshadow::ForeshadowCreatePayload {
    serde_json::from_value(json!({
        "id": id,
        "requestId": request_id,
        "sessionId": "renderer-session",
        "eventUid": format!("event-{request_id}"),
        "origin": "human",
        "projectId": project_id,
        "title": id
    }))
    .expect("foreshadow payload")
}

fn maintenance_transaction_id(response: &Value) -> String {
    response["maintenanceTransactionId"]
        .as_str()
        .expect("maintenance transaction id")
        .to_string()
}

#[test]
fn foreshadow_typed_inverse_allows_a_new_journal_for_the_same_root_only() {
    let db = migrated_db();
    let root = foreshadow::create(
        &db,
        foreshadow_payload("foreshadow-lineage-root", "project-a", "fs-lineage-root"),
    )
    .expect("create lineage root");
    let unrelated = foreshadow::create(
        &db,
        foreshadow_payload(
            "foreshadow-lineage-unrelated",
            "project-a",
            "fs-lineage-unrelated",
        ),
    )
    .expect("create unrelated same-project root");
    let foreign = foreshadow::create(
        &db,
        foreshadow_payload(
            "foreshadow-lineage-foreign",
            "project-b",
            "fs-lineage-foreign",
        ),
    )
    .expect("create foreign root");
    let root_transaction = maintenance_transaction_id(&root);

    let same_root_update = serde_json::from_value(json!({
        "requestId": "fs-same-root-update-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-same-root-update-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-a",
        "baseVersion": root["version"],
        "title": "same-root inverse update"
    }))
    .expect("same-root Foreshadow inverse update");
    let updated_root =
        foreshadow::update(&db, "foreshadow-lineage-root".to_string(), same_root_update)
            .expect("journal-less Foreshadow inverse for the same root");

    let unrelated_update = serde_json::from_value(json!({
        "requestId": "fs-wrong-entity-update-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-wrong-entity-update-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-a",
        "baseVersion": unrelated["version"],
        "title": "must roll back"
    }))
    .expect("unrelated Foreshadow inverse update");
    let error = foreshadow::update(
        &db,
        "foreshadow-lineage-unrelated".to_string(),
        unrelated_update,
    )
    .expect_err("journal-less same-project inverse for another root must fail");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let foreign_update = serde_json::from_value(json!({
        "requestId": "fs-cross-project-update-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-cross-project-update-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-b",
        "baseVersion": foreign["version"],
        "title": "must roll back"
    }))
    .expect("foreign Foreshadow inverse update");
    let error = foreshadow::update(
        &db,
        "foreshadow-lineage-foreign".to_string(),
        foreign_update,
    )
    .expect_err("journal-less cross-project inverse must fail");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let wrong_entity: foreshadow::ForeshadowDeletePayload = serde_json::from_value(json!({
        "id": "foreshadow-lineage-unrelated",
        "projectId": "project-a",
        "baseVersion": unrelated["version"],
        "requestId": "fs-wrong-entity-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-wrong-entity-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction
    }))
    .expect("unrelated delete payload");
    let error = foreshadow::delete(&db, wrong_entity)
        .expect_err("same-project transaction for another root must fail closed");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let foreign_entity: foreshadow::ForeshadowDeletePayload = serde_json::from_value(json!({
        "id": "foreshadow-lineage-foreign",
        "projectId": "project-b",
        "baseVersion": foreign["version"],
        "requestId": "fs-cross-project-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-cross-project-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction
    }))
    .expect("foreign delete payload");
    let error = foreshadow::delete(&db, foreign_entity)
        .expect_err("cross-project transaction must fail closed");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let inverse: foreshadow::ForeshadowDeletePayload = serde_json::from_value(json!({
        "id": "foreshadow-lineage-root",
        "projectId": "project-a",
        "baseVersion": updated_root["version"],
        "requestId": "fs-same-root-undo",
        "sessionId": "renderer-session",
        "eventUid": "fs-same-root-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction
    }))
    .expect("same-root inverse payload");
    let deleted = foreshadow::delete(&db, inverse)
        .expect("typed inverse may own a fresh delete Undo Journal");
    let inverse_transaction = maintenance_transaction_id(&deleted);
    let lineage: (String, String, Option<String>, Option<String>) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT cause_kind, origin, original_transaction_id, undo_journal_id
                   FROM narrative_change_transactions WHERE id = ?1",
                [&inverse_transaction],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(Into::into)
        })
        .expect("load inverse lineage");
    assert_eq!(lineage.0, "undo");
    assert_eq!(lineage.1, "undo");
    assert_eq!(lineage.2.as_deref(), Some(root_transaction.as_str()));
    assert_eq!(lineage.3.as_deref(), deleted["undoJournalId"].as_str());

    let inverse_journal = deleted["undoJournalId"]
        .as_str()
        .expect("typed inverse Undo Journal")
        .to_string();
    let restored = grimodex_db::agent_writes::agent_undo_journal_impl(
        &db,
        grimodex_db::agent_writes::AgentUndoJournalPayload {
            request_id: "fs-same-root-redo-via-journal".to_string(),
            project_id: "project-a".to_string(),
            session_id: "renderer-session".to_string(),
            journal_id: inverse_journal.clone(),
            direction: "undo".to_string(),
            authority_route: "history-replay".to_string(),
            origin: "undo".to_string(),
            caller: "undo-redo-command".to_string(),
            controls: vec![
                "original-transaction".to_string(),
                "journal-lineage".to_string(),
                "typed-writer".to_string(),
                "occ".to_string(),
                "change-event".to_string(),
                "change-feed".to_string(),
            ],
        },
    )
    .expect("typed inverse journal resolves its root forward lineage");
    let restored_transaction = maintenance_transaction_id(&restored);
    let restored_lineage: (String, String, Option<String>, Option<String>) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT cause_kind, origin, original_transaction_id, undo_journal_id
                   FROM narrative_change_transactions WHERE id = ?1",
                [&restored_transaction],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(Into::into)
        })
        .expect("load typed inverse replay lineage");
    assert_eq!(restored_lineage.0, "undo");
    assert_eq!(restored_lineage.1, "undo");
    assert_eq!(
        restored_lineage.2.as_deref(),
        Some(root_transaction.as_str())
    );
    assert_eq!(
        restored_lineage.3.as_deref(),
        Some(inverse_journal.as_str())
    );

    let remaining: (i64, i64, i64) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM foreshadows WHERE id = 'foreshadow-lineage-root'),
                   (SELECT COUNT(*) FROM foreshadows WHERE id = 'foreshadow-lineage-unrelated'),
                   (SELECT COUNT(*) FROM foreshadows WHERE id = 'foreshadow-lineage-foreign')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(Into::into)
        })
        .expect("load final roots");
    assert_eq!(remaining, (1, 1, 1));
}

#[test]
fn plot_journal_less_inverse_requires_the_same_project_entity_root() {
    let db = migrated_db();
    let root = plot_threads::create(&db, plot_thread_payload("plot-lineage-root"))
        .expect("create plot lineage root");
    plot_threads::create(&db, plot_thread_payload("plot-lineage-unrelated"))
        .expect("create unrelated plot root");
    let foreign_payload: plot_threads::PlotThreadCreatePayload = serde_json::from_value(json!({
        "id": "plot-lineage-foreign",
        "requestId": "request-plot-lineage-foreign",
        "sessionId": "renderer-session",
        "eventUid": "event-plot-lineage-foreign",
        "origin": "human",
        "projectId": "project-b",
        "name": "Foreign",
        "sortOrder": "a0"
    }))
    .expect("foreign plot payload");
    plot_threads::create(&db, foreign_payload).expect("create foreign plot root");
    let root_transaction = maintenance_transaction_id(&root);

    let same_root_patch = serde_json::from_value(json!({
        "requestId": "plot-same-root-undo",
        "sessionId": "renderer-session",
        "eventUid": "plot-same-root-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-a",
        "name": "Root inverse",
        "baseVersion": root["version"]
    }))
    .expect("same-root plot inverse");
    plot_threads::update(&db, "plot-lineage-root".to_string(), same_root_patch)
        .expect("journal-less typed inverse for the same root");

    let unrelated_patch = serde_json::from_value(json!({
        "requestId": "plot-wrong-root-undo",
        "sessionId": "renderer-session",
        "eventUid": "plot-wrong-root-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-a",
        "name": "Must roll back",
        "baseVersion": 0
    }))
    .expect("unrelated plot inverse");
    let error = plot_threads::update(&db, "plot-lineage-unrelated".to_string(), unrelated_patch)
        .expect_err("same-project transaction for another Plot root must fail");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let foreign_patch = serde_json::from_value(json!({
        "requestId": "plot-cross-project-undo",
        "sessionId": "renderer-session",
        "eventUid": "plot-cross-project-undo-event",
        "origin": "undo",
        "originalTransactionId": root_transaction,
        "projectId": "project-b",
        "name": "Must roll back",
        "baseVersion": 0
    }))
    .expect("foreign plot inverse");
    let error = plot_threads::update(&db, "plot-lineage-foreign".to_string(), foreign_patch)
        .expect_err("cross-project Plot transaction must fail");
    assert!(
        error
            .to_string()
            .contains("does not identify the same project entity"),
        "{error:#}"
    );

    let state: (String, i64, String, i64) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT
                   (SELECT name FROM plot_threads WHERE id = 'plot-lineage-unrelated'),
                   (SELECT version FROM plot_threads WHERE id = 'plot-lineage-unrelated'),
                   (SELECT name FROM plot_threads WHERE id = 'plot-lineage-foreign'),
                   (SELECT version FROM plot_threads WHERE id = 'plot-lineage-foreign')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(Into::into)
        })
        .expect("load rolled-back Plot roots");
    assert_eq!(
        state,
        (
            "plot-lineage-unrelated".to_string(),
            0,
            "Foreign".to_string(),
            0
        )
    );
}
