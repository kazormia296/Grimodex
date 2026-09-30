#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::agent_writes::{agent_undo_journal_impl, AgentUndoJournalPayload};
use grimodex_db::snippet_writes::{
    create, delete, update, SnippetCreatePayload, SnippetDeletePayload, SnippetUpdatePayload,
};
use grimodex_db::Database;
use serde_json::{json, Value};

fn fixture() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
             INSERT INTO tree_nodes
               (id, project_id, node_type, title, sort_order, version)
             VALUES
               ('scene-p1', 'p1', 'scene', 'One', 'a0', 0),
               ('scene-p2', 'p2', 'scene', 'Two', 'a0', 0);",
        )?;
        Ok(())
    })
    .expect("seed database");
    db
}

fn create_payload(request_id: &str) -> SnippetCreatePayload {
    serde_json::from_value(json!({
        "requestId": request_id,
        "sessionId": format!("session:{request_id}"),
        "eventUid": format!("event:{request_id}"),
        "origin": "human",
        "authorityRoute": "human-direct",
        "caller": "human-ui",
        "controls": ["runtime-policy", "actor-context", "typed-writer", "occ", "change-event", "change-feed"],
        "writesAuthorityProtectedField": false,
        "originalTransactionId": null,
        "undoJournalId": null,
        "projectId": "p1",
        "snippetId": "snippet-1",
        "title": "Before",
        "content": "{\"type\":\"doc\"}",
        "tagsCache": null,
        "contentSource": "human",
        "sceneId": "scene-p1",
        "sourceChatMessageId": null,
        "canonicalPayload": { "title": "Before", "sceneId": "scene-p1" }
    }))
    .expect("decode create payload")
}

fn update_payload(request_id: &str, base_version: i64) -> SnippetUpdatePayload {
    serde_json::from_value(json!({
        "requestId": request_id,
        "sessionId": format!("session:{request_id}"),
        "eventUid": format!("event:{request_id}"),
        "origin": "human",
        "authorityRoute": "human-direct",
        "caller": "human-ui",
        "controls": ["runtime-policy", "actor-context", "typed-writer", "occ", "change-event", "change-feed"],
        "writesAuthorityProtectedField": false,
        "originalTransactionId": null,
        "undoJournalId": null,
        "projectId": "p1",
        "snippetId": "snippet-1",
        "baseVersion": base_version,
        "title": "After",
        "canonicalPayload": { "fields": ["title"] }
    }))
    .expect("decode update payload")
}

fn delete_payload(request_id: &str, base_version: i64) -> SnippetDeletePayload {
    serde_json::from_value(json!({
        "requestId": request_id,
        "sessionId": format!("session:{request_id}"),
        "eventUid": format!("event:{request_id}"),
        "origin": "human",
        "authorityRoute": "human-direct",
        "caller": "human-ui",
        "controls": ["runtime-policy", "actor-context", "typed-writer", "occ", "change-event", "change-feed"],
        "writesAuthorityProtectedField": false,
        "originalTransactionId": null,
        "undoJournalId": null,
        "projectId": "p1",
        "snippetId": "snippet-1",
        "baseVersion": base_version,
        "canonicalPayload": { "title": "After" }
    }))
    .expect("decode delete payload")
}

fn count(db: &Database, table: &str) -> i64 {
    db.with_conn(|conn| {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(Into::into)
    })
    .expect("count table")
}

fn replay(db: &Database, journal_id: &str, direction: &str, request_id: &str) {
    agent_undo_journal_impl(
        db,
        AgentUndoJournalPayload {
            request_id: request_id.to_string(),
            project_id: "p1".to_string(),
            session_id: format!("session:{request_id}"),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
            authority_route: "history-replay".to_string(),
            origin: direction.to_string(),
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
    .expect("replay snippet journal");
}

#[test]
fn manual_snippet_crud_is_atomic_idempotent_occ_guarded_and_replayable() {
    let db = fixture();
    let created = create(&db, create_payload("snippet-create")).expect("create snippet");
    assert_eq!(created["version"], 1);
    assert_eq!(created["undoJournalId"], "snippet-create");

    let mut create_retry = create_payload("snippet-create");
    create_retry.session_id = "session:after-restart".to_string();
    create_retry.event_uid = "event:ignored-retry".to_string();
    assert_eq!(
        create(&db, create_retry).expect("retry create"),
        created,
        "same logical request must return its original receipt",
    );
    assert_eq!(count(&db, "snippets"), 1);
    assert_eq!(count(&db, "undo_journal"), 1);
    assert_eq!(count(&db, "change_events"), 1);
    assert_eq!(count(&db, "narrative_change_transactions"), 1);
    db.with_conn(|conn| {
        let payload: String = conn.query_row(
            "SELECT payload FROM change_events WHERE event_uid = 'event:snippet-create'",
            [],
            |row| row.get(0),
        )?;
        let payload: Value = serde_json::from_str(&payload)?;
        assert_eq!(payload["authorityRoute"], "human-direct");
        assert_eq!(payload["authorityEvidence"]["validated"], true);
        Ok(())
    })
    .expect("inspect snippet authority evidence");

    let stale = update_payload("snippet-stale", 0);
    assert!(update(&db, stale)
        .expect_err("stale update must fail")
        .to_string()
        .contains("version conflict"));

    let updated = update(&db, update_payload("snippet-update", 1)).expect("update snippet");
    assert_eq!(updated["version"], 2);
    let update_journal = updated["undoJournalId"]
        .as_str()
        .expect("update journal")
        .to_string();
    let mut update_retry = update_payload("snippet-update", 1);
    update_retry.session_id = "session:update-retry".to_string();
    update_retry.event_uid = "event:update-retry".to_string();
    assert_eq!(update(&db, update_retry).expect("retry update"), updated);

    replay(&db, &update_journal, "undo", "snippet-update-undo");
    let after_undo: (String, i64) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT title, version FROM snippets WHERE id = 'snippet-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })
        .expect("read undone snippet");
    assert_eq!(after_undo.0, "Before");
    assert!(
        after_undo.1 > 2,
        "Undo must allocate a fresh OCC generation"
    );
    replay(&db, &update_journal, "redo", "snippet-update-redo");
    let after_redo: (String, i64) = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT title, version FROM snippets WHERE id = 'snippet-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })
        .expect("read redone snippet");
    assert_eq!(after_redo.0, "After");
    assert!(after_redo.1 > after_undo.1);

    let deleted =
        delete(&db, delete_payload("snippet-delete", after_redo.1)).expect("delete snippet");
    let delete_journal = deleted["undoJournalId"]
        .as_str()
        .expect("delete journal")
        .to_string();
    assert_eq!(count(&db, "snippets"), 0);
    replay(&db, &delete_journal, "undo", "snippet-delete-undo");
    assert_eq!(count(&db, "snippets"), 1);
    replay(&db, &delete_journal, "redo", "snippet-delete-redo");
    assert_eq!(count(&db, "snippets"), 0);

    let origins: Vec<(String, String)> = db
        .with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT cause_kind, origin FROM narrative_change_transactions
                  ORDER BY source_change_event_sequence",
            )?;
            let rows = statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(Into::into);
            rows
        })
        .expect("read feed origins");
    assert!(origins.contains(&("forward".to_string(), "human".to_string())));
    assert!(origins.contains(&("undo".to_string(), "undo".to_string())));
    assert!(origins.contains(&("redo".to_string(), "redo".to_string())));
}

#[test]
fn manual_snippet_rejects_cross_project_references_and_feed_failure_rolls_back() {
    let db = fixture();
    let mut cross_project = create_payload("snippet-cross-project");
    cross_project.scene_id = Some("scene-p2".to_string());
    assert!(create(&db, cross_project)
        .expect_err("foreign scene must fail")
        .to_string()
        .contains("scene is not in project"));
    assert_eq!(count(&db, "snippets"), 0);

    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_manual_snippet_feed
               BEFORE INSERT ON narrative_change_transactions
               BEGIN SELECT RAISE(ABORT, 'forced manual snippet feed failure'); END;",
        )?;
        Ok(())
    })
    .expect("install failure trigger");
    let error = create(&db, create_payload("snippet-rollback"))
        .expect_err("Feed failure must abort the entire write");
    assert!(error
        .to_string()
        .contains("forced manual snippet feed failure"));
    for table in [
        "snippets",
        "undo_journal",
        "change_events",
        "narrative_change_transactions",
        "idempotency_requests",
    ] {
        assert_eq!(count(&db, table), 0, "{table} must roll back");
    }
}

#[test]
fn manual_snippet_retry_conflicts_when_payload_changes() {
    let db = fixture();
    create(&db, create_payload("snippet-conflict")).expect("first create");
    let mut conflicting = create_payload("snippet-conflict");
    conflicting.title = "Different".to_string();
    let error = create(&db, conflicting).expect_err("changed retry must conflict");
    assert!(error
        .to_string()
        .contains("SNIPPET_CREATE_IDEMPOTENCY_CONFLICT"));
    let title: Value = db
        .with_conn(|conn| {
            conn.query_row(
                "SELECT json_quote(title) FROM snippets WHERE id = 'snippet-1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map(|raw| serde_json::from_str(&raw).expect("decode title"))
            .map_err(Into::into)
        })
        .expect("read snippet title");
    assert_eq!(title, "Before");
}
