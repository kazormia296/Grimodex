use grimodex_db::narrative_extraction::change_feed::{
    acknowledge_cursor, append_change_transaction, events_affecting_application,
    get_changes_since, AppendChangeEventInput, AppendChangeTransactionInput, ChangeEventRecord,
};
use grimodex_db::Database;
use serde_json::json;

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db
}

fn change_event(object_key: &str, change_kind: &str) -> AppendChangeEventInput {
    AppendChangeEventInput {
        event_id: None,
        object_key_json: json!({ "kind": "codex-entry", "id": object_key }),
        change_kind: change_kind.to_string(),
        before_version: Some(1),
        before_digest: Some("digest-before".to_string()),
        after_version: Some(2),
        after_digest: Some("digest-after".to_string()),
        changed_paths_json: json!(["summary", "content"]),
        text_impact_json: None,
        structural_impact_json: None,
    }
}

fn append(db: &Database, project_id: &str, cause: serde_json::Value, events: Vec<AppendChangeEventInput>) -> serde_json::Value {
    append_change_transaction(
        db,
        AppendChangeTransactionInput {
            transaction_id: None,
            project_id: project_id.to_string(),
            cause_json: cause,
            events,
        },
    )
    .expect("append change transaction")
}

#[test]
fn append_advances_sequence_once_per_transaction_with_multiple_events() {
    let db = migrated_db();

    let first = append(
        &db,
        "project-1",
        json!({ "kind": "manual-edit" }),
        vec![change_event("entry-a", "update"), change_event("entry-b", "update")],
    );
    let second = append(
        &db,
        "project-1",
        json!({ "kind": "manual-edit" }),
        vec![change_event("entry-c", "update")],
    );

    assert_eq!(first["projectSequence"], 1);
    assert_eq!(second["projectSequence"], 2);
    assert_eq!(first["eventIds"].as_array().expect("event ids").len(), 2);
    assert_eq!(second["eventIds"].as_array().expect("event ids").len(), 1);

    let events = get_changes_since(&db, "project-1", 0).expect("get changes since");
    assert_eq!(events.len(), 3);
    // Both events from the first transaction share the same allocated sequence.
    assert_eq!(events[0].project_sequence, 1);
    assert_eq!(events[1].project_sequence, 1);
    assert_eq!(events[2].project_sequence, 2);
}

#[test]
fn get_changes_since_returns_ordinals_in_order() {
    let db = migrated_db();
    append(
        &db,
        "project-1",
        json!({ "kind": "manual-edit" }),
        vec![
            change_event("entry-a", "update"),
            change_event("entry-b", "update"),
            change_event("entry-c", "update"),
        ],
    );

    let events = get_changes_since(&db, "project-1", 0).expect("get changes since");
    let ordinals: Vec<i64> = events.iter().map(|event| event.event_ordinal).collect();
    assert_eq!(ordinals, vec![0, 1, 2]);

    // after_sequence excludes everything at or below the given sequence.
    let none = get_changes_since(&db, "project-1", 1).expect("get changes since none");
    assert!(none.is_empty());
}

#[test]
fn acknowledge_cursor_is_monotonic() {
    let db = migrated_db();
    append(&db, "project-1", json!({ "kind": "manual-edit" }), vec![change_event("entry-a", "update")]);
    append(&db, "project-1", json!({ "kind": "manual-edit" }), vec![change_event("entry-b", "update")]);
    append(&db, "project-1", json!({ "kind": "manual-edit" }), vec![change_event("entry-c", "update")]);

    let advanced = acknowledge_cursor(&db, "project-1", "consumer-a", 2).expect("advance cursor");
    assert_eq!(advanced["acknowledgedThroughSequence"], 2);

    // A stale acknowledgement behind the current value must not rewind it.
    let stale = acknowledge_cursor(&db, "project-1", "consumer-a", 1).expect("stale ack");
    assert_eq!(stale["acknowledgedThroughSequence"], 2);

    let further = acknowledge_cursor(&db, "project-1", "consumer-a", 3).expect("advance further");
    assert_eq!(further["acknowledgedThroughSequence"], 3);
}

#[test]
fn self_stale_filter_excludes_own_narrative_commit_events_at_or_below_baseline() {
    let db = migrated_db();
    append(
        &db,
        "project-1",
        json!({ "kind": "narrative-commit", "applicationId": "app-1" }),
        vec![change_event("entry-a", "update")],
    );
    append(
        &db,
        "project-1",
        json!({ "kind": "manual-edit" }),
        vec![change_event("entry-b", "update")],
    );
    append(
        &db,
        "project-1",
        json!({ "kind": "narrative-commit", "applicationId": "app-1" }),
        vec![change_event("entry-c", "update")],
    );
    append(
        &db,
        "project-1",
        json!({ "kind": "narrative-commit", "applicationId": "app-2" }),
        vec![change_event("entry-d", "update")],
    );

    let events: Vec<ChangeEventRecord> = get_changes_since(&db, "project-1", 0).expect("get all changes");
    assert_eq!(events.len(), 4);

    // Baseline sequence 0 (nothing acknowledged yet): the app's own sequence-1
    // and sequence-3 narrative-commits are excluded regardless of baseline,
    // while the manual edit and the other application's commit remain.
    let affecting = events_affecting_application(&events, "app-1", 0);
    let sequences: Vec<i64> = affecting.iter().map(|event| event.project_sequence).collect();
    assert_eq!(sequences, vec![2, 4]);

    // Raising the baseline to the app's own commit sequence additionally
    // drops everything at or below it, independent of cause.
    let affecting_at_baseline = events_affecting_application(&events, "app-1", 2);
    let sequences_at_baseline: Vec<i64> = affecting_at_baseline
        .iter()
        .map(|event| event.project_sequence)
        .collect();
    assert_eq!(sequences_at_baseline, vec![4]);
}
