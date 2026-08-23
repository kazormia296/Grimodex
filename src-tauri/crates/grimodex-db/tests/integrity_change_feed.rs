use std::path::Path;

use grimodex_db::agent_writes::{agent_codex_create_impl, AgentCodexCreatePayload};
use grimodex_db::narrative_extraction::change_feed::narrative_snapshot_digest;
use grimodex_db::snippet_writes::{create as snippet_create, SnippetCreatePayload};
use grimodex_db::{Database, RepairIntegrityPayload};

fn canonical_codex_digest(db: &Database, project_id: &str, entry_id: &str) -> String {
    db.with_conn(|conn| {
        let raw: String = conn.query_row(
            "SELECT json_object(
                'id', id, 'projectId', project_id, 'type', type, 'name', name,
                'summary', summary, 'content', content, 'aliases', aliases,
                'excludedAliases', excluded_aliases, 'readings', readings,
                'tagsCache', tags_cache, 'parentId', parent_id, 'icon', icon,
                'contextMode', context_mode, 'childrenBudget', children_budget,
                'sourceChatMessageId', source_chat_message_id, 'notes', notes,
                'createdAt', created_at, 'version', version
             ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![entry_id, project_id],
            |row| row.get(0),
        )?;
        let snapshot: serde_json::Value = serde_json::from_str(&raw)?;
        Ok(narrative_snapshot_digest(&snapshot)?)
    })
    .expect("read canonical Codex snapshot")
}

fn canonical_snippet_digest(db: &Database, project_id: &str, snippet_id: &str) -> String {
    db.with_conn(|conn| {
        let raw: String = conn.query_row(
            "SELECT json_object(
                'id', id, 'projectId', project_id, 'title', title,
                'content', content, 'tagsCache', tags_cache,
                'contentSource', content_source, 'sceneId', scene_id,
                'sourceChatMessageId', source_chat_message_id,
                'createdAt', created_at,
                'updatedAt', updated_at, 'version', version
             ) FROM snippets WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![snippet_id, project_id],
            |row| row.get(0),
        )?;
        let snapshot: serde_json::Value = serde_json::from_str(&raw)?;
        Ok(narrative_snapshot_digest(&snapshot)?)
    })
    .expect("read canonical Snippet snapshot")
}

fn fixture() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('repair-p1', 'One'), ('repair-p2', 'Two');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
               VALUES ('cross-project-scene', 'repair-p2', 'scene', 'Foreign scene', 'a0');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('cross-project-session', 'repair-p2', 'Foreign session');
             INSERT INTO chat_messages (id, session_id, role, content)
               VALUES ('cross-project-message', 'cross-project-session', 'user', 'Foreign');",
        )?;
        conn.pragma_update(None, "foreign_keys", "OFF")?;
        conn.execute_batch(
            "INSERT INTO codex_entries
               (id, project_id, type, name, source_chat_message_id, version, updated_at)
             VALUES
               ('codex-b', 'repair-p1', 'character', 'B', 'cross-project-message', 4, '2026-08-12T01:00:00.000Z'),
               ('codex-a', 'repair-p1', 'character', 'A', 'missing-chat-a', 2, '2026-08-12T02:00:00.000Z'),
               ('codex-other', 'repair-p2', 'character', 'Other', 'missing-chat-other', 8, '2026-08-12T03:00:00.000Z');
             INSERT INTO snippets
               (id, project_id, title, source_chat_message_id, scene_id, version, updated_at)
             VALUES
               ('snippet-b', 'repair-p1', 'B', 'cross-project-message', 'cross-project-scene', 7, '2026-08-12T04:00:00.000Z'),
               ('snippet-a', 'repair-p1', 'A', 'missing-chat-a', NULL, 3, '2026-08-12T05:00:00.000Z'),
               ('snippet-other', 'repair-p2', 'Other', 'missing-chat-other', 'missing-scene-other', 9, '2026-08-12T06:00:00.000Z');",
        )?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(())
    })
    .expect("seed corrupt references");
    db
}

fn payload() -> RepairIntegrityPayload {
    RepairIntegrityPayload {
        project_id: "repair-p1".to_string(),
        request_id: "repair-request-1".to_string(),
        session_id: "repair-session-1".to_string(),
        event_uid: "repair-event-1".to_string(),
        occurred_at: "2026-08-13T10:00:00.000Z".to_string(),
        authority_route: "restore-or-migration".to_string(),
        caller: "integrity-repair".to_string(),
        controls: vec![
            "exclusive-system-operation".to_string(),
            "semantic-epoch-event".to_string(),
            "full-rebuild-marker".to_string(),
        ],
        provenance: None,
        writes_authority_protected_field: false,
    }
}

#[test]
fn repair_integrity_is_atomic_idempotent_deterministic_and_project_scoped() {
    let db = fixture();
    let before = db
        .integrity_check("repair-p1")
        .expect("check project-scoped corruption");
    assert_eq!(before["orphanedCodexSources"], 2);
    assert_eq!(before["orphanedSnippetSources"], 2);
    assert_eq!(before["orphanedSnippetScenes"], 1);
    let codex_b_before = canonical_codex_digest(&db, "repair-p1", "codex-b");
    let snippet_b_before = canonical_snippet_digest(&db, "repair-p1", "snippet-b");
    let first = db.repair_integrity(payload()).expect("repair project");
    assert_eq!(first.codex_sources_fixed, 2);
    assert_eq!(first.snippet_sources_fixed, 2);
    assert_eq!(first.snippet_scenes_fixed, 1);
    assert!(first.maintenance_transaction_id.is_some());
    let codex_b_after = canonical_codex_digest(&db, "repair-p1", "codex-b");
    let snippet_b_after = canonical_snippet_digest(&db, "repair-p1", "snippet-b");

    let mut replay_payload = payload();
    replay_payload.session_id = "repair-session-after-restart".to_string();
    replay_payload.event_uid = "repair-event-after-restart".to_string();
    let replay = db
        .repair_integrity(replay_payload)
        .expect("replay exact logical repair");
    assert_eq!(replay, first);

    let mut changed_occurred_at = payload();
    changed_occurred_at.occurred_at = "2026-08-13T10:00:01.000Z".to_string();
    let conflict = db
        .repair_integrity(changed_occurred_at)
        .expect_err("the retained occurredAt is part of logical repair identity");
    assert!(conflict
        .to_string()
        .contains("REPAIR_INTEGRITY_IDEMPOTENCY_CONFLICT"));

    db.with_conn(|conn| {
        let p1_codex = conn
            .prepare(
                "SELECT id, source_chat_message_id, version
                   FROM codex_entries
                  WHERE project_id = 'repair-p1'
                  ORDER BY id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            p1_codex,
            vec![
                ("codex-a".to_string(), None, 3),
                ("codex-b".to_string(), None, 5),
            ]
        );

        let p1_snippets = conn
            .prepare(
                "SELECT id, source_chat_message_id, scene_id, version
                   FROM snippets
                  WHERE project_id = 'repair-p1'
                  ORDER BY id",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            p1_snippets,
            vec![
                ("snippet-a".to_string(), None, None, 4),
                ("snippet-b".to_string(), None, None, 8),
            ]
        );

        let other: (Option<String>, Option<String>, Option<String>, i64, i64) = conn.query_row(
            "SELECT entry.source_chat_message_id,
                    snippet.source_chat_message_id,
                    snippet.scene_id,
                    entry.version,
                    snippet.version
               FROM codex_entries entry
               JOIN snippets snippet ON snippet.project_id = entry.project_id
              WHERE entry.id = 'codex-other' AND snippet.id = 'snippet-other'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )?;
        assert_eq!(
            other,
            (
                Some("missing-chat-other".to_string()),
                Some("missing-chat-other".to_string()),
                Some("missing-scene-other".to_string()),
                8,
                9,
            )
        );

        let transaction: (String, String, String) = conn.query_row(
            "SELECT origin, cause_kind, source_change_event_uid
               FROM narrative_change_transactions
              WHERE project_id = 'repair-p1' AND request_id = 'repair-request-1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(
            transaction,
            (
                "restore".to_string(),
                "forward".to_string(),
                "repair-event-1".to_string(),
            )
        );
        let canonical_payload: String = conn.query_row(
            "SELECT payload FROM change_events WHERE project_id = 'repair-p1' AND event_uid = 'repair-event-1'",
            [],
            |row| row.get(0),
        )?;
        let canonical_payload: serde_json::Value = serde_json::from_str(&canonical_payload)?;
        assert_eq!(canonical_payload["authorityRoute"], "restore-or-migration");
        assert_eq!(canonical_payload["authorityCaller"], "integrity-repair");
        assert_eq!(canonical_payload["authorityEvidence"]["status"], "validated");
        let event_keys = conn
            .prepare(
                "SELECT object_key_json, changed_paths_json,
                        before_digest, after_digest
                   FROM narrative_change_events event
                   JOIN narrative_change_transactions transaction_row
                     ON transaction_row.id = event.transaction_id
                  WHERE transaction_row.project_id = 'repair-p1'
                    AND transaction_row.request_id = 'repair-request-1'
                  ORDER BY event.event_ordinal",
            )?
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(event_keys.len(), 5);
        assert!(event_keys[0].0.contains("\"kind\":\"project\""));
        assert!(event_keys[1].0.contains("codex-a"));
        assert!(event_keys[2].0.contains("codex-b"));
        assert!(event_keys[3].0.contains("snippet-a"));
        assert!(event_keys[4].0.contains("snippet-b"));
        assert_eq!(
            serde_json::from_str::<Vec<String>>(&event_keys[4].1)?,
            vec!["/sceneId", "/sourceChatMessageId"]
        );
        assert_eq!(event_keys[2].2, codex_b_before);
        assert_eq!(event_keys[2].3, codex_b_after);
        assert_eq!(event_keys[4].2, snippet_b_before);
        assert_eq!(event_keys[4].3, snippet_b_after);

        let counts: (i64, i64, i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM change_events WHERE project_id = 'repair-p1' AND event_uid = 'repair-event-1'),
               (SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = 'repair-p1' AND request_id = 'repair-request-1'),
               (SELECT COUNT(*) FROM narrative_change_events WHERE project_id = 'repair-p1'),
               (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'repair_integrity' AND request_id = 'repair-request-1')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        assert_eq!(counts, (1, 1, 5, 1));

        // Gate C2 Lane A/N: Integrity Repair mints exactly one Semantic
        // Epoch, even though repair_integrity was called three times above
        // (first repair, idempotent replay, and a rejected occurredAt
        // conflict that never reached the epoch-rotation call).
        let epochs: Vec<(i64, String, Option<String>)> = conn
            .prepare(
                "SELECT epoch_number, reason, triggered_by_change_event_uid
                   FROM narrative_semantic_epochs
                  WHERE project_id = 'repair-p1'
                  ORDER BY epoch_number ASC",
            )?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        assert_eq!(
            epochs.len(),
            1,
            "the idempotent replay must not mint a second Epoch: {epochs:?}"
        );
        assert_eq!(epochs[0].0, 0);
        assert_eq!(epochs[0].1, "migration");
        assert_eq!(epochs[0].2.as_deref(), Some("repair-event-1"));

        let foreign_authorities: (i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM chat_messages message
                 JOIN chat_sessions session ON session.id = message.session_id
                WHERE message.id = 'cross-project-message'
                  AND session.project_id = 'repair-p2'),
               (SELECT COUNT(*) FROM tree_nodes
                 WHERE id = 'cross-project-scene' AND project_id = 'repair-p2')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(foreign_authorities, (1, 1));
        Ok(())
    })
    .expect("verify persisted repair");

    let mut cross_project_reuse = payload();
    cross_project_reuse.project_id = "repair-p2".to_string();
    assert!(db.repair_integrity(cross_project_reuse).is_err());
}

#[test]
fn repair_integrity_feed_failure_rolls_back_domain_canonical_and_retry_ledger() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch(
            "CREATE TRIGGER fail_integrity_repair_feed
               BEFORE INSERT ON narrative_change_transactions
               BEGIN SELECT RAISE(ABORT, 'forced integrity repair Feed failure'); END;",
        )?;
        Ok(())
    })
    .expect("install failure trigger");

    let error = db
        .repair_integrity(payload())
        .expect_err("Feed failure must fail repair");
    assert!(error
        .to_string()
        .contains("forced integrity repair Feed failure"));

    db.with_conn(|conn| {
        let state: (Option<String>, i64) = conn.query_row(
            "SELECT source_chat_message_id, version
               FROM codex_entries
              WHERE id = 'codex-a' AND project_id = 'repair-p1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        assert_eq!(state, (Some("missing-chat-a".to_string()), 2));
        let counts: (i64, i64, i64) = conn.query_row(
            "SELECT
               (SELECT COUNT(*) FROM change_events WHERE event_uid = 'repair-event-1'),
               (SELECT COUNT(*) FROM narrative_change_transactions WHERE request_id = 'repair-request-1'),
               (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'repair_integrity' AND request_id = 'repair-request-1')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        assert_eq!(counts, (0, 0, 0));
        let epoch_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'repair-p1'",
            [],
            |row| row.get(0),
        )?;
        assert_eq!(
            epoch_count, 0,
            "a rolled-back repair must not leave a Semantic Epoch behind"
        );
        Ok(())
    })
    .expect("verify complete rollback");
}

#[test]
fn repair_integrity_chains_from_a_canonical_codex_feed_head() {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES
                 ('canonical-repair-p1', 'One'), ('canonical-repair-p2', 'Two');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('canonical-repair-session', 'canonical-repair-p2', 'Foreign session');
             INSERT INTO chat_messages (id, session_id, role, content)
               VALUES ('canonical-repair-message', 'canonical-repair-session', 'user', 'Foreign');",
        )?;
        Ok(())
    })
    .expect("seed canonical repair projects and source message");

    agent_codex_create_impl(
        &db,
        AgentCodexCreatePayload {
            request_id: Some("canonical-repair-codex-create".to_string()),
            entry_id: Some("canonical-repair-codex".to_string()),
            project_id: "canonical-repair-p1".to_string(),
            session_id: "canonical-repair-session-p1".to_string(),
            surface: None,
            type_slug: "character".to_string(),
            name: "Foreign source".to_string(),
            summary: Some(String::new()),
            content: Some("{}".to_string()),
            aliases: None,
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
            parent_id: None,
            source_chat_message_id: Some("canonical-repair-message".to_string()),
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: Vec::new(),
        },
    )
    .expect("canonical Codex create with cross-project source");

    let repaired = db
        .repair_integrity(RepairIntegrityPayload {
            project_id: "canonical-repair-p1".to_string(),
            request_id: "canonical-repair-request".to_string(),
            session_id: "canonical-repair-session-p1".to_string(),
            event_uid: "canonical-repair-event".to_string(),
            occurred_at: "2026-08-23T00:00:00.000Z".to_string(),
            authority_route: "restore-or-migration".to_string(),
            caller: "integrity-repair".to_string(),
            controls: vec![
                "exclusive-system-operation".to_string(),
                "semantic-epoch-event".to_string(),
                "full-rebuild-marker".to_string(),
            ],
            provenance: None,
            writes_authority_protected_field: false,
        })
        .expect("repair must chain from the canonical Codex Feed head");
    assert_eq!(repaired.codex_sources_fixed, 1);
    assert_eq!(repaired.snippet_sources_fixed, 0);
    assert_eq!(repaired.snippet_scenes_fixed, 0);
    assert_eq!(
        repaired.change_event_uid.as_deref(),
        Some("canonical-repair-event")
    );
}

#[test]
fn repair_integrity_chains_from_a_canonical_snippet_feed_head() {
    let db = Database::new(Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES
                 ('canonical-snippet-p1', 'One'), ('canonical-snippet-p2', 'Two');
             INSERT INTO chat_sessions (id, project_id, title)
               VALUES ('canonical-snippet-session', 'canonical-snippet-p1', 'Local session');
             INSERT INTO chat_messages (id, session_id, role, content)
               VALUES ('canonical-snippet-message', 'canonical-snippet-session', 'user', 'Local');",
        )?;
        Ok(())
    })
    .expect("seed canonical snippet projects and source message");

    snippet_create(
        &db,
        SnippetCreatePayload {
            request_id: "canonical-snippet-create".to_string(),
            session_id: "canonical-snippet-session".to_string(),
            event_uid: "canonical-snippet-create-event".to_string(),
            origin: grimodex_db::narrative_extraction::change_feed::NarrativeChangeOrigin::Human,
            authority_route: "human-direct".to_string(),
            caller: "human-ui".to_string(),
            controls: vec![
                "runtime-policy".to_string(),
                "actor-context".to_string(),
                "typed-writer".to_string(),
                "occ".to_string(),
                "change-event".to_string(),
                "change-feed".to_string(),
            ],
            provenance: None,
            writes_authority_protected_field: false,
            original_transaction_id: None,
            undo_journal_id: None,
            project_id: "canonical-snippet-p1".to_string(),
            snippet_id: "canonical-snippet".to_string(),
            title: "Foreign source after drift".to_string(),
            content: "{}".to_string(),
            tags_cache: None,
            content_source: Some("human".to_string()),
            scene_id: None,
            source_chat_message_id: Some("canonical-snippet-message".to_string()),
            canonical_payload: None,
        },
    )
    .expect("canonical Snippet create with local source");

    // The canonical writer records the complete Snippet Feed head. Simulate
    // legacy ownership drift through the unprotected chat-session fixture row;
    // the Snippet row and its prior canonical head remain unchanged, while
    // Integrity Repair now observes the source as cross-project.
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_sessions SET project_id = 'canonical-snippet-p2'
              WHERE id = 'canonical-snippet-session'",
            [],
        )?;
        Ok(())
    })
    .expect("create cross-project source drift");

    let repaired = db
        .repair_integrity(RepairIntegrityPayload {
            project_id: "canonical-snippet-p1".to_string(),
            request_id: "canonical-snippet-repair".to_string(),
            session_id: "canonical-snippet-repair-session".to_string(),
            event_uid: "canonical-snippet-repair-event".to_string(),
            occurred_at: "2026-08-23T00:00:00.000Z".to_string(),
            authority_route: "restore-or-migration".to_string(),
            caller: "integrity-repair".to_string(),
            controls: vec![
                "exclusive-system-operation".to_string(),
                "semantic-epoch-event".to_string(),
                "full-rebuild-marker".to_string(),
            ],
            provenance: None,
            writes_authority_protected_field: false,
        })
        .expect("repair must chain from the canonical Snippet Feed head");
    assert_eq!(repaired.codex_sources_fixed, 0);
    assert_eq!(repaired.snippet_sources_fixed, 1);
    assert_eq!(repaired.snippet_scenes_fixed, 0);
    assert_eq!(
        repaired.change_event_uid.as_deref(),
        Some("canonical-snippet-repair-event")
    );
}
