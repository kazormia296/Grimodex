#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_core::SCHEMA_VERSION;
use grimodex_db::change_events::{append_change_events_in_tx, AppendChangeEvent};
use grimodex_db::narrative_extraction::change_feed::{
    acknowledge_cursor_in_tx, append_narrative_change_transaction_in_tx,
    events_from_journal_entities, get_changes_since, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use grimodex_db::Database;
use rusqlite::Connection;
use serde_json::json;

const PROJECT_ONE: &str = "project-1";
const PROJECT_TWO: &str = "project-2";

fn migrated_db() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    seed_projects(db)
}

fn fresh_migrated_db() -> Database {
    let db = test_support::fresh_migrated_memory().expect("migrate database");
    seed_projects(db)
}

fn seed_projects(db: Database) -> Database {
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES
                ('project-1', 'Project One'),
                ('project-2', 'Project Two');",
        )?;
        Ok(())
    })
    .expect("seed projects");
    db
}

fn narrative_event(entity_id: &str, mutation_kind: &str) -> NarrativeChangeEventInput {
    let (before_version, before_digest, after_version, after_digest) = match mutation_kind {
        "create" | "restore" => (
            None,
            None,
            Some(2),
            Some(format!("sha256:after-{entity_id}")),
        ),
        "delete" => (
            Some(1),
            Some(format!("sha256:before-{entity_id}")),
            None,
            None,
        ),
        _ => (
            Some(1),
            Some(format!("sha256:before-{entity_id}")),
            Some(2),
            Some(format!("sha256:after-{entity_id}")),
        ),
    };
    NarrativeChangeEventInput {
        object_key: json!({ "kind": "codex-entry", "entryId": entity_id }),
        change_kind: "metadata".to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version,
        before_digest,
        after_version,
        after_digest,
        changed_paths: vec!["/summary".to_string(), "/content".to_string()],
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": ["/summary", "/content"] })),
    }
}

fn canonical_event(event_uid: &str, entity_id: &str, timestamp: i64) -> AppendChangeEvent {
    AppendChangeEvent {
        event_uid: event_uid.to_string(),
        scene_id: None,
        domain: "narrative.commit".to_string(),
        op_type: "narrative.commit.apply".to_string(),
        entity_type: Some("codex_entry".to_string()),
        entity_id: Some(entity_id.to_string()),
        payload: json!({ "entityId": entity_id }).to_string(),
        timestamp,
    }
}

fn append_canonical_in_tx(
    conn: &Connection,
    project_id: &str,
    event_uid: &str,
    entity_id: &str,
    timestamp: i64,
) -> i64 {
    conn.execute(
        "INSERT OR IGNORE INTO codex_entries (id, project_id, type, name)
         VALUES (?1, ?2, 'character', ?1)",
        [entity_id, project_id],
    )
    .expect("seed project-owned Feed object");
    append_change_events_in_tx(
        conn,
        project_id,
        "test-session",
        &[canonical_event(event_uid, entity_id, timestamp)],
    )
    .expect("append canonical change event")
    .tail_sequence
}

fn transaction_input(
    project_id: &str,
    request_id: &str,
    source_change_event_uid: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> AppendNarrativeChangeTransactionInput {
    AppendNarrativeChangeTransactionInput {
        project_id: project_id.to_string(),
        request_id: request_id.to_string(),
        source_domain: "narrative.commit.apply".to_string(),
        source_change_event_uid: source_change_event_uid.to_string(),
        cause_kind: NarrativeChangeCauseKind::Forward,
        origin: NarrativeChangeOrigin::Human,
        original_transaction_id: None,
        commit_id: None,
        journal_id: None,
        undo_journal_id: None,
        application_ids: vec![],
        occurred_at: "2026-08-13T00:00:00.000Z".to_string(),
        events,
    }
}

fn append_committed(
    db: &Database,
    project_id: &str,
    request_id: &str,
    event_uid: &str,
    entity_id: &str,
    events: Vec<NarrativeChangeEventInput>,
) -> grimodex_db::narrative_extraction::change_feed::AppendNarrativeChangeTransactionResult {
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        for event in &events {
            if event.mutation_kind != "delete" {
                if let Some(entry_id) = event
                    .object_key
                    .get("entryId")
                    .and_then(serde_json::Value::as_str)
                {
                    conn.execute(
                        "INSERT OR IGNORE INTO codex_entries (id, project_id, type, name)
                         VALUES (?1, ?2, 'character', ?1)",
                        [entry_id, project_id],
                    )?;
                }
            }
        }
        append_canonical_in_tx(conn, project_id, event_uid, entity_id, 1_786_579_200_000);
        let result = append_narrative_change_transaction_in_tx(
            conn,
            &transaction_input(project_id, request_id, event_uid, events),
        )?;
        conn.execute_batch("COMMIT")?;
        Ok(result)
    })
    .expect("append feed transaction")
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get(0)
    })
    .expect("count table")
}

#[test]
fn object_head_lookup_is_index_backed_after_a_large_head_fixture() {
    let db = migrated_db();
    append_committed(
        &db,
        PROJECT_ONE,
        "head-anchor-request",
        "head-anchor-event",
        "head-anchor",
        vec![narrative_event("head-anchor", "create")],
    );

    db.with_conn(|conn| {
        let anchor_event_id: String = conn.query_row(
            "SELECT id FROM narrative_change_events
              WHERE project_id = ?1
              LIMIT 1",
            [PROJECT_ONE],
            |row| row.get(0),
        )?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        for index in 0..10_000_i64 {
            conn.execute(
                "INSERT INTO narrative_change_object_heads (
                    project_id, object_identity, after_version, after_digest,
                    event_id, canonical_sequence, event_ordinal, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7)",
                rusqlite::params![
                    PROJECT_ONE,
                    format!("{{\"kind\":\"scene\",\"sceneId\":\"scene-{index}\"}}"),
                    index,
                    format!("sha256:head-{index}"),
                    anchor_event_id,
                    index + 1,
                    "2026-08-13T00:00:00.000Z",
                ],
            )?;
        }
        conn.execute_batch("COMMIT")?;

        let details = conn
            .prepare(
                "EXPLAIN QUERY PLAN
                   SELECT after_version, after_digest
                     FROM narrative_change_object_heads
                    WHERE project_id = ?1
                      AND object_identity = ?2",
            )?
            .query_map(
                [
                    PROJECT_ONE,
                    "{\"kind\":\"scene\",\"sceneId\":\"scene-9999\"}",
                ],
                |row| row.get::<_, String>(3),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert!(
            details.iter().any(|detail| detail.contains("USING INDEX")),
            "object head lookup lost its identity index: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("narrative_change_events")),
            "continuity lookup must not scan the historical feed: {details:?}"
        );
        Ok(())
    })
    .expect("large object-head fixture remains indexed");
}

#[test]
fn continuity_guard_rejects_a_mismatched_head_and_rolls_back_domain_state() {
    let db = migrated_db();
    append_committed(
        &db,
        PROJECT_ONE,
        "continuity-create",
        "continuity-create-event",
        "continuity-entry",
        vec![narrative_event("continuity-entry", "create")],
    );

    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        conn.execute(
            "UPDATE codex_entries SET name = 'must-roll-back' WHERE id = 'continuity-entry'",
            [],
        )?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "continuity-bad-event",
            "continuity-entry",
            1_786_579_200_100,
        );
        let error = append_narrative_change_transaction_in_tx(
            conn,
            &transaction_input(
                PROJECT_ONE,
                "continuity-bad",
                "continuity-bad-event",
                vec![narrative_event("continuity-entry", "update")],
            ),
        )
        .expect_err("mismatched prior after/current before must fail closed");
        assert!(error
            .to_string()
            .contains("NARRATIVE_CHANGE_FEED_DISCONTINUITY"));
        conn.execute_batch("ROLLBACK")?;
        let name: String = conn.query_row(
            "SELECT name FROM codex_entries WHERE id = 'continuity-entry'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(name, "continuity-entry");
        Ok(())
    })
    .expect("continuity rollback");
}

#[test]
fn continuity_guard_chains_repeated_roots_in_event_ordinal_order() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "continuity-chain-event",
            "continuity-chain",
            1_786_579_200_101,
        );
        let first = NarrativeChangeEventInput {
            after_version: Some(1),
            after_digest: Some("sha256:one".to_string()),
            ..narrative_event("continuity-chain", "create")
        };
        let second = NarrativeChangeEventInput {
            before_version: Some(1),
            before_digest: Some("sha256:one".to_string()),
            after_version: Some(2),
            after_digest: Some("sha256:two".to_string()),
            ..narrative_event("continuity-chain", "update")
        };
        let result = append_narrative_change_transaction_in_tx(
            conn,
            &transaction_input(
                PROJECT_ONE,
                "continuity-chain",
                "continuity-chain-event",
                vec![first, second],
            ),
        )?;
        assert_eq!(result.event_ids.len(), 2);
        conn.execute_batch("COMMIT")?;
        Ok(())
    })
    .expect("same-root event chain");
}

/// One transaction carries one canonical sequence, and its events differ
/// only by `event_ordinal`. The Contribution projection watermarks each row
/// by sequence alone, so of two events at one sequence bearing on the same
/// field it can keep only the first -- and its cursor then acknowledges the
/// sequence, putting the other beyond replay.
///
/// That is harmless while every repeated identity in a transaction carries
/// the same mutation kind, because the projection derives `missing` only
/// from a delete and stamps a transaction-wide timestamp, so the refused
/// write would have been byte-identical. Mixing a delete with a non-delete
/// is the shape that would genuinely lose information, and no writer builds
/// it. This keeps it that way, so the projection can stay one-dimensional
/// rather than growing an ordering key the cursor does not share.
#[test]
fn continuity_guard_rejects_a_delete_and_a_non_delete_for_one_object() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "mixed-mutation-event",
            "mixed-mutation",
            1_786_579_200_102,
        );
        let created = NarrativeChangeEventInput {
            after_version: Some(1),
            after_digest: Some("sha256:one".to_string()),
            ..narrative_event("mixed-mutation", "create")
        };
        let deleted = NarrativeChangeEventInput {
            before_version: Some(1),
            before_digest: Some("sha256:one".to_string()),
            mutation_kind: "delete".to_string(),
            ..narrative_event("mixed-mutation", "delete")
        };
        let error = append_narrative_change_transaction_in_tx(
            conn,
            &transaction_input(
                PROJECT_ONE,
                "mixed-mutation",
                "mixed-mutation-event",
                vec![created, deleted],
            ),
        )
        .expect_err("a delete and a non-delete for one object must not share a sequence");
        assert!(
            format!("{error:#}").contains("NARRATIVE_CHANGE_FEED_MIXED_MUTATION"),
            "unexpected error: {error:#}"
        );
        conn.execute_batch("ROLLBACK")?;
        Ok(())
    })
    .expect("mixed mutation rejection");
}

#[test]
fn fresh_schema_22_contains_the_canonical_writer_origin_contract() {
    let db = fresh_migrated_db();
    db.with_conn(|conn| {
        let version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
        // SCHEMA 22 introduced this contract; SCHEMA 23-41 (Gate C2/D1/C2A/NIR-1,
        // current Human capture/retirement and parent-delete lifecycle) migrate further on top.
        // This guard exists so the next schema bump revisits this test too.
        assert_eq!(SCHEMA_VERSION, 41);
        assert_eq!(version, SCHEMA_VERSION);

        for table in [
            "narrative_change_transactions",
            "narrative_change_events",
            "narrative_change_cursors",
            "narrative_change_sets",
        ] {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                [table],
                |row| row.get(0),
            )?;
            assert_eq!(exists, 1, "missing SCHEMA 22 table {table}");
        }
        let (not_null, default_value): (i64, Option<String>) = conn.query_row(
            "SELECT \"notnull\", dflt_value FROM pragma_table_info('narrative_change_transactions')
              WHERE name = 'origin'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(not_null, 1);
        assert_eq!(default_value, None);
        Ok(())
    })
    .expect("inspect schema");
}

#[test]
fn origin_is_persisted_and_must_match_undo_redo_cause() {
    let db = migrated_db();
    let mut input = transaction_input(
        PROJECT_ONE,
        "request-origin",
        "canonical-origin",
        vec![narrative_event("entry-origin", "update")],
    );
    input.origin = NarrativeChangeOrigin::Undo;

    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "canonical-origin",
            "entry-origin",
            1_786_579_200_010,
        );
        let error = append_narrative_change_transaction_in_tx(conn, &input)
            .expect_err("forward cause cannot claim undo origin");
        assert!(error.to_string().contains("origin"));
        conn.execute_batch("ROLLBACK")?;
        Ok(())
    })
    .expect("validate origin");
}

#[test]
fn append_requires_a_caller_transaction_and_rolls_back_with_domain_state() {
    let db = migrated_db();
    let input = transaction_input(
        PROJECT_ONE,
        "request-rollback",
        "canonical-rollback",
        vec![narrative_event("entry-rollback", "update")],
    );

    db.with_conn(|conn| {
        let outside = append_narrative_change_transaction_in_tx(conn, &input)
            .expect_err("append outside transaction must fail");
        assert!(outside.to_string().contains("caller-owned transaction"));

        conn.execute_batch("BEGIN IMMEDIATE")?;
        conn.execute(
            "UPDATE projects SET title = 'Mutated' WHERE id = ?1",
            [PROJECT_ONE],
        )?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "canonical-rollback",
            "entry-rollback",
            1_786_579_200_001,
        );
        append_narrative_change_transaction_in_tx(conn, &input)?;
        conn.execute_batch("ROLLBACK")?;

        let title: String = conn.query_row(
            "SELECT title FROM projects WHERE id = ?1",
            [PROJECT_ONE],
            |row| row.get(0),
        )?;
        assert_eq!(title, "Project One");
        assert_eq!(count(conn, "change_events"), 0);
        assert_eq!(count(conn, "narrative_change_transactions"), 0);
        assert_eq!(count(conn, "narrative_change_events"), 0);
        Ok(())
    })
    .expect("atomic rollback");
}

#[test]
fn duplicate_request_replays_without_duplicates_and_conflicting_payload_is_rejected() {
    let db = migrated_db();
    let input = transaction_input(
        PROJECT_ONE,
        "request-idempotent",
        "canonical-idempotent",
        vec![narrative_event("entry-idempotent", "update")],
    );

    let first = db
        .with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            append_canonical_in_tx(
                conn,
                PROJECT_ONE,
                "canonical-idempotent",
                "entry-idempotent",
                1_786_579_200_002,
            );
            let result = append_narrative_change_transaction_in_tx(conn, &input)?;
            conn.execute_batch("COMMIT")?;
            Ok(result)
        })
        .expect("first append");
    assert!(!first.replayed);

    let replay = db
        .with_conn(|conn| {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = append_narrative_change_transaction_in_tx(conn, &input)?;
            conn.execute_batch("COMMIT")?;
            Ok(result)
        })
        .expect("idempotent replay");
    assert!(replay.replayed);
    assert_eq!(replay.transaction_id, first.transaction_id);
    assert_eq!(replay.event_ids, first.event_ids);

    let mut conflicting = input.clone();
    conflicting.events[0].changed_paths = vec!["/name".to_string()];
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let error = append_narrative_change_transaction_in_tx(conn, &conflicting)
            .expect_err("request payload conflict");
        assert!(
            error
                .to_string()
                .contains("NARRATIVE_CHANGE_FEED_IDEMPOTENCY_CONFLICT"),
            "error={error}"
        );
        conn.execute_batch("ROLLBACK")?;
        assert_eq!(count(conn, "narrative_change_transactions"), 1);
        assert_eq!(count(conn, "narrative_change_events"), 1);
        Ok(())
    })
    .expect("conflict remains atomic");
}

#[test]
fn empty_changed_paths_are_rejected_before_feed_persistence() {
    let db = migrated_db();
    let mut event = narrative_event("entry-empty-paths", "update");
    event.changed_paths.clear();
    let input = transaction_input(
        PROJECT_ONE,
        "request-empty-paths",
        "canonical-empty-paths",
        vec![event],
    );

    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let error = append_narrative_change_transaction_in_tx(conn, &input)
            .expect_err("empty changedPaths must be rejected");
        assert!(error
            .to_string()
            .contains("changedPaths must contain at least one path"));
        conn.execute_batch("ROLLBACK")?;
        assert_eq!(count(conn, "narrative_change_transactions"), 0);
        assert_eq!(count(conn, "narrative_change_events"), 0);
        Ok(())
    })
    .expect("validate empty changedPaths");
}

#[test]
fn source_event_and_original_transaction_references_are_project_scoped() {
    let db = migrated_db();
    let first = append_committed(
        &db,
        PROJECT_ONE,
        "request-project-one",
        "canonical-project-one",
        "entry-one",
        vec![narrative_event("entry-one", "create")],
    );

    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let wrong_source = transaction_input(
            PROJECT_TWO,
            "request-wrong-source",
            "canonical-project-one",
            vec![narrative_event("entry-cross", "update")],
        );
        let error = append_narrative_change_transaction_in_tx(conn, &wrong_source)
            .expect_err("cross-project canonical event");
        assert!(error.to_string().contains("not in project 'project-2'"));
        conn.execute_batch("ROLLBACK")?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_canonical_in_tx(
            conn,
            PROJECT_TWO,
            "canonical-project-two",
            "entry-two",
            1_786_579_200_003,
        );
        let mut wrong_original = transaction_input(
            PROJECT_TWO,
            "request-wrong-original",
            "canonical-project-two",
            vec![narrative_event("entry-two", "restore")],
        );
        wrong_original.cause_kind = NarrativeChangeCauseKind::Redo;
        wrong_original.origin = NarrativeChangeOrigin::Redo;
        wrong_original.original_transaction_id = Some(first.transaction_id.clone());
        let error = append_narrative_change_transaction_in_tx(conn, &wrong_original)
            .expect_err("cross-project original transaction");
        assert!(error
            .to_string()
            .contains("original transaction is not in project"));
        conn.execute_batch("ROLLBACK")?;

        assert!(get_changes_since(conn, PROJECT_TWO, 0, 50)?.is_empty());
        let project_one = get_changes_since(conn, PROJECT_ONE, 0, 50)?;
        assert_eq!(project_one.len(), 1);
        assert_eq!(project_one[0].project_id, PROJECT_ONE);
        assert_eq!(project_one[0].origin, NarrativeChangeOrigin::Human);
        Ok(())
    })
    .expect("project isolation");
}

#[test]
fn existing_feed_object_from_another_project_is_rejected() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('foreign-entry', 'project-2', 'character', 'Foreign')",
            [],
        )?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "canonical-foreign-object",
            "foreign-entry",
            1_786_579_200_004,
        );
        let input = transaction_input(
            PROJECT_ONE,
            "request-foreign-object",
            "canonical-foreign-object",
            vec![narrative_event("foreign-entry", "update")],
        );
        let error = append_narrative_change_transaction_in_tx(conn, &input)
            .expect_err("foreign Feed object must be rejected");
        assert!(error.to_string().contains("another project"));
        conn.execute_batch("ROLLBACK")?;
        assert_eq!(count(conn, "narrative_change_transactions"), 0);
        assert_eq!(count(conn, "narrative_change_events"), 0);
        Ok(())
    })
    .expect("validate Feed object project scope");
}

#[test]
fn missing_live_feed_object_is_rejected_for_non_delete_mutations() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch("BEGIN IMMEDIATE")?;
        append_change_events_in_tx(
            conn,
            PROJECT_ONE,
            "test-session",
            &[canonical_event(
                "canonical-missing-object",
                "missing-entry",
                1_786_579_200_005,
            )],
        )?;
        let input = transaction_input(
            PROJECT_ONE,
            "request-missing-object",
            "canonical-missing-object",
            vec![narrative_event("missing-entry", "update")],
        );
        let error = append_narrative_change_transaction_in_tx(conn, &input)
            .expect_err("missing live object must fail closed");
        assert!(error.to_string().contains("not in project"), "{error}");
        conn.execute_batch("ROLLBACK")?;
        assert_eq!(count(conn, "narrative_change_transactions"), 0);
        assert_eq!(count(conn, "narrative_change_events"), 0);
        Ok(())
    })
    .expect("validate missing Feed object");
}

#[test]
fn logical_feed_roots_and_registered_components_are_fail_closed_by_project() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO import_sessions (
                 id, state, target_json, created_at, updated_at
             ) VALUES (
                 'foreign-import', 'ready', '{\"projectId\":\"project-2\"}',
                 '2026-08-13T00:00:00Z', '2026-08-13T00:00:00Z'
             );
             INSERT INTO codex_tags (id, project_id, name)
             VALUES ('foreign-tag', 'project-2', 'Foreign');",
        )?;

        let cases = [
            (
                "calendar",
                NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "calendar",
                        "calendarRef": PROJECT_TWO,
                    }),
                    change_kind: "calendar".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: Some(1),
                    before_digest: Some("sha256:before-calendar".to_string()),
                    after_version: Some(2),
                    after_digest: Some("sha256:after-calendar".to_string()),
                    changed_paths: vec!["/".to_string()],
                    text_impact: None,
                    structural_impact: None,
                },
            ),
            (
                "import-source",
                NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "import-source",
                        "sourceSetId": "foreign-import",
                        "objectKey": PROJECT_ONE,
                    }),
                    change_kind: "metadata".to_string(),
                    mutation_kind: "create".to_string(),
                    before_version: None,
                    before_digest: None,
                    after_version: Some(1),
                    after_digest: Some("sha256:after-import".to_string()),
                    changed_paths: vec!["/".to_string()],
                    text_impact: None,
                    structural_impact: None,
                },
            ),
            (
                "component",
                NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "component",
                        "componentId": "codex-tag:foreign-tag",
                    }),
                    change_kind: "catalog".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: Some(1),
                    before_digest: Some("sha256:before-tag".to_string()),
                    after_version: Some(2),
                    after_digest: Some("sha256:after-tag".to_string()),
                    changed_paths: vec!["/name".to_string()],
                    text_impact: None,
                    structural_impact: None,
                },
            ),
            (
                "unregistered-component",
                NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "component",
                        "componentId": "arbitrary-sql-table:foreign-row",
                    }),
                    change_kind: "metadata".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: Some(1),
                    before_digest: Some("sha256:before-arbitrary".to_string()),
                    after_version: Some(2),
                    after_digest: Some("sha256:after-arbitrary".to_string()),
                    changed_paths: vec!["/".to_string()],
                    text_impact: None,
                    structural_impact: None,
                },
            ),
        ];

        for (index, (label, event)) in cases.into_iter().enumerate() {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let canonical_uid = format!("canonical-logical-scope-{index}");
            append_canonical_in_tx(
                conn,
                PROJECT_ONE,
                &canonical_uid,
                label,
                1_786_579_200_100 + index as i64,
            );
            let input = transaction_input(
                PROJECT_ONE,
                &format!("request-logical-scope-{index}"),
                &canonical_uid,
                vec![event],
            );
            let error = append_narrative_change_transaction_in_tx(conn, &input)
                .expect_err("logical Feed root must reject foreign or unregistered identity");
            assert!(
                error.to_string().contains("another project")
                    || error.to_string().contains("not registered"),
                "{label}: unexpected error: {error}"
            );
            conn.execute_batch("ROLLBACK")?;
        }

        assert_eq!(count(conn, "narrative_change_transactions"), 0);
        assert_eq!(count(conn, "narrative_change_events"), 0);
        Ok(())
    })
    .expect("validate logical Feed project scope");
}

#[test]
fn undo_lineage_cannot_reuse_another_commit_root_in_the_same_project() {
    let db = migrated_db();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO narrative_apply_commits
                (id, project_id, request_id, plan_digest, status, created_at, version)
             VALUES
                ('commit-a', 'project-1', 'commit-request-a', 'digest-a', 'applied', '2026-08-13T00:00:00Z', 1),
                ('commit-b', 'project-1', 'commit-request-b', 'digest-b', 'applied', '2026-08-13T00:00:00Z', 1);
             INSERT INTO narrative_commit_journals
                (id, commit_id, project_id, after_json, created_at)
             VALUES
                ('journal-a', 'commit-a', 'project-1', '{\"entities\":[]}', '2026-08-13T00:00:00Z'),
                ('journal-b', 'commit-b', 'project-1', '{\"entities\":[]}', '2026-08-13T00:00:00Z');",
        )?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, type, name)
             VALUES ('entry-a', 'project-1', 'character', 'Entry A')",
            [],
        )?;
        append_canonical_in_tx(
            conn,
            PROJECT_ONE,
            "canonical-commit-a",
            "commit-a",
            1_786_579_200_010,
        );
        let mut root_input = transaction_input(
            PROJECT_ONE,
            "feed-request-a",
            "canonical-commit-a",
            vec![narrative_event("entry-a", "create")],
        );
        root_input.commit_id = Some("commit-a".to_string());
        root_input.journal_id = Some("journal-a".to_string());
        let root = append_narrative_change_transaction_in_tx(conn, &root_input)?;
        conn.execute_batch("COMMIT")?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        let mut canonical_undo = canonical_event(
            "canonical-commit-b-undo",
            "commit-b",
            1_786_579_200_011,
        );
        canonical_undo.op_type = "narrative.commit.undo".to_string();
        append_change_events_in_tx(conn, PROJECT_ONE, "test-session", &[canonical_undo])?;
        let mut wrong_lineage = transaction_input(
            PROJECT_ONE,
            "feed-request-b-undo",
            "canonical-commit-b-undo",
            vec![narrative_event("entry-b", "delete")],
        );
        wrong_lineage.source_domain = "narrative.commit.undo".to_string();
        wrong_lineage.cause_kind = NarrativeChangeCauseKind::Undo;
        wrong_lineage.origin = NarrativeChangeOrigin::Undo;
        wrong_lineage.original_transaction_id = Some(root.transaction_id);
        wrong_lineage.commit_id = Some("commit-b".to_string());
        wrong_lineage.journal_id = Some("journal-b".to_string());
        let error = append_narrative_change_transaction_in_tx(conn, &wrong_lineage)
            .expect_err("same-project cross-commit lineage must be rejected");
        assert!(error
            .to_string()
            .contains("original transaction does not belong to the named commit"));
        conn.execute_batch("ROLLBACK")?;
        Ok(())
    })
    .expect("validate commit-scoped lineage");
}

#[test]
fn project_delete_cascades_feed_lineage_after_undo_and_redo() {
    let db = migrated_db();
    let forward = append_committed(
        &db,
        PROJECT_ONE,
        "request-cascade-forward",
        "canonical-cascade-forward",
        "entry-cascade",
        vec![narrative_event("entry-cascade", "create")],
    );

    db.with_conn(|conn| {
        for (cause, request_id, event_uid, source_domain, mutation_kind) in [
            (
                NarrativeChangeCauseKind::Undo,
                "request-cascade-undo",
                "canonical-cascade-undo",
                "narrative.commit.undo",
                "delete",
            ),
            (
                NarrativeChangeCauseKind::Redo,
                "request-cascade-redo",
                "canonical-cascade-redo",
                "narrative.commit.redo",
                "restore",
            ),
        ] {
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let mut canonical = canonical_event(event_uid, "entry-cascade", 1_786_579_200_004);
            canonical.op_type = source_domain.to_string();
            append_change_events_in_tx(conn, PROJECT_ONE, "test-session", &[canonical])?;
            append_narrative_change_transaction_in_tx(
                conn,
                &AppendNarrativeChangeTransactionInput {
                    project_id: PROJECT_ONE.to_string(),
                    request_id: request_id.to_string(),
                    source_domain: source_domain.to_string(),
                    source_change_event_uid: event_uid.to_string(),
                    cause_kind: cause,
                    origin: match cause {
                        NarrativeChangeCauseKind::Undo => NarrativeChangeOrigin::Undo,
                        NarrativeChangeCauseKind::Redo => NarrativeChangeOrigin::Redo,
                        NarrativeChangeCauseKind::Forward => NarrativeChangeOrigin::Human,
                    },
                    original_transaction_id: Some(forward.transaction_id.clone()),
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: vec![],
                    occurred_at: "2026-08-13T00:00:04.000Z".to_string(),
                    events: vec![match mutation_kind {
                        "delete" => NarrativeChangeEventInput {
                            before_version: Some(2),
                            before_digest: Some("sha256:after-entry-cascade".to_string()),
                            after_version: None,
                            after_digest: None,
                            ..narrative_event("entry-cascade", "delete")
                        },
                        "restore" => NarrativeChangeEventInput {
                            before_version: None,
                            before_digest: None,
                            after_version: Some(3),
                            after_digest: Some("sha256:restored-entry-cascade".to_string()),
                            ..narrative_event("entry-cascade", "restore")
                        },
                        _ => unreachable!(),
                    }],
                },
            )?;
            conn.execute_batch("COMMIT")?;
        }

        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = ?1",
                [PROJECT_ONE],
                |row| row.get::<_, i64>(0),
            )?,
            3
        );
        conn.execute("DELETE FROM projects WHERE id = ?1", [PROJECT_ONE])?;

        for table in [
            "change_events",
            "narrative_change_transactions",
            "narrative_change_events",
            "narrative_change_cursors",
            "narrative_change_sets",
        ] {
            let remaining: i64 = conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
                [PROJECT_ONE],
                |row| row.get(0),
            )?;
            assert_eq!(remaining, 0, "project-owned rows remain in {table}");
        }
        let foreign_key_violations = conn
            .prepare("PRAGMA foreign_key_check")?
            .query_map([], |_| Ok(()))?
            .count();
        assert_eq!(foreign_key_violations, 0);
        Ok(())
    })
    .expect("project cascade with feed lineage");
}

#[test]
fn reads_follow_canonical_sequence_and_ordinal_and_cursor_is_bounded() {
    let db = migrated_db();
    let first = append_committed(
        &db,
        PROJECT_ONE,
        "request-order-one",
        "canonical-order-one",
        "entry-a",
        vec![
            narrative_event("entry-a", "update"),
            narrative_event("entry-b", "update"),
        ],
    );
    let second = append_committed(
        &db,
        PROJECT_ONE,
        "request-order-two",
        "canonical-order-two",
        "entry-c",
        vec![narrative_event("entry-c", "delete")],
    );
    assert_eq!(first.canonical_sequence, 1);
    assert_eq!(second.canonical_sequence, 2);

    db.with_conn(|conn| {
        let first_page = get_changes_since(conn, PROJECT_ONE, 0, 1)?;
        assert_eq!(first_page.len(), 2);
        assert_eq!(
            first_page
                .iter()
                .map(|event| (event.canonical_sequence, event.event_ordinal))
                .collect::<Vec<_>>(),
            vec![(1, 0), (1, 1)]
        );
        assert_eq!(
            first_page
                .iter()
                .map(|event| event.transaction_id.as_str())
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            1,
            "a page must never split one canonical transaction"
        );
        assert!(first_page
            .iter()
            .all(|event| event.canonical_change_event_uid == "canonical-order-one"));

        let after_first = get_changes_since(conn, PROJECT_ONE, 1, 50)?;
        assert_eq!(after_first.len(), 1);
        assert_eq!(after_first[0].canonical_sequence, 2);
        assert_eq!(after_first[0].event_ordinal, 0);
        assert_eq!(
            after_first[0].canonical_change_event_uid,
            "canonical-order-two"
        );

        assert!(get_changes_since(conn, PROJECT_ONE, -1, 50).is_err());
        assert!(get_changes_since(conn, PROJECT_ONE, 0, 0).is_err());
        assert!(get_changes_since(conn, PROJECT_ONE, 0, 501).is_err());

        conn.execute_batch("BEGIN IMMEDIATE")?;
        assert_eq!(
            acknowledge_cursor_in_tx(
                conn,
                PROJECT_ONE,
                "consumer-a",
                1,
                "2026-08-13T00:00:01.000Z",
            )?,
            1
        );
        conn.execute_batch("COMMIT")?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        assert_eq!(
            acknowledge_cursor_in_tx(
                conn,
                PROJECT_ONE,
                "consumer-a",
                0,
                "2026-08-13T00:00:02.000Z",
            )?,
            1,
            "stale acknowledgement must not rewind"
        );
        conn.execute_batch("COMMIT")?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        let overrun = acknowledge_cursor_in_tx(
            conn,
            PROJECT_ONE,
            "consumer-a",
            3,
            "2026-08-13T00:00:03.000Z",
        )
        .expect_err("cursor beyond project head");
        assert!(overrun.to_string().contains("exceeds project feed head 2"));
        conn.execute_batch("ROLLBACK")?;

        conn.execute_batch("BEGIN IMMEDIATE")?;
        let cross_project = acknowledge_cursor_in_tx(
            conn,
            PROJECT_TWO,
            "consumer-a",
            1,
            "2026-08-13T00:00:04.000Z",
        )
        .expect_err("other project has no feed head");
        assert!(cross_project.to_string().contains("project feed head 0"));
        conn.execute_batch("ROLLBACK")?;
        Ok(())
    })
    .expect("ordered read and cursor");
}

#[test]
fn journal_contract_distinguishes_forward_undo_redo_delete_and_restore() {
    let create = vec![json!({
        "entityKind": "codex_entry",
        "entityId": "entry-created",
        "opKind": "create",
        "version": 1,
        "snapshot": { "id": "entry-created", "version": 1 }
    })];
    let deleted = vec![json!({
        "entityKind": "foreshadow",
        "entityId": "foreshadow-deleted",
        "opKind": "delete",
        "version": 7,
        "beforeSnapshot": { "id": "foreshadow-deleted", "version": 7 }
    })];

    assert_eq!(
        events_from_journal_entities(&create, NarrativeChangeCauseKind::Forward).unwrap()[0]
            .mutation_kind,
        "create"
    );
    assert_eq!(
        events_from_journal_entities(&create, NarrativeChangeCauseKind::Undo).unwrap()[0]
            .mutation_kind,
        "delete"
    );
    assert_eq!(
        events_from_journal_entities(&create, NarrativeChangeCauseKind::Redo).unwrap()[0]
            .mutation_kind,
        "restore"
    );

    assert_eq!(
        events_from_journal_entities(&deleted, NarrativeChangeCauseKind::Forward).unwrap()[0]
            .mutation_kind,
        "delete"
    );
    assert_eq!(
        events_from_journal_entities(&deleted, NarrativeChangeCauseKind::Undo).unwrap()[0]
            .mutation_kind,
        "restore"
    );
    assert_eq!(
        events_from_journal_entities(&deleted, NarrativeChangeCauseKind::Redo).unwrap()[0]
            .mutation_kind,
        "delete"
    );

    let ensure_existing = vec![json!({
        "entityKind": "temporal_node",
        "entityId": "node-existing",
        "opKind": "ensure-existing",
        "version": 3,
        "snapshot": { "id": "node-existing", "version": 3 }
    })];
    for direction in [
        NarrativeChangeCauseKind::Forward,
        NarrativeChangeCauseKind::Undo,
        NarrativeChangeCauseKind::Redo,
    ] {
        assert!(events_from_journal_entities(&ensure_existing, direction)
            .unwrap()
            .is_empty());
    }
}
