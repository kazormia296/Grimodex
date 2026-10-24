//! NIR-1 DA-2b CW (K3/2 "chat の書込みの入口" rows 4-8, CW conditions 1-5,
//! Positive (8), Negative (27); DR-DA2-50): the typed Native chat writers.
//!
//! Condition map (the DR keeps the same table):
//! * 1 (place, arguments, results): `*_scope_*`, `*_rejects_invalid_*`,
//!   `results_are_counts_only`.
//! * 2 (nothing inserted, surviving rows unchanged, three record keys only):
//!   `rename_writes_only_title_manual_and_updated_at`,
//!   `metadata_record_keeps_other_keys_and_message_versions`,
//!   `metadata_record_rejects_other_keys_without_writing`,
//!   `no_writer_inserts_a_row`.
//! * 3 (effects through the existing foreign keys and canonical triggers):
//!   `message_delete_follows_foreign_keys_and_canonical_triggers`,
//!   `session_delete_and_clear_cascade_and_keep_attempts_and_feed`.
//! * 4 (unterminated attempts refuse deletion, nothing deleted):
//!   `pending_attempt_refuses_every_deletion_and_deletes_nothing`,
//!   `terminal_attempt_allows_deletion`.
//! * 5 (unrestricted results unchanged, D-11 (a)):
//!   `typed_writers_match_the_current_generic_sql_results`.
#![cfg(feature = "native-current-human-capture")]

#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::chat_typed_writes::{
    clear_project_history, delete_messages, delete_session, record_message_metadata, refusal_of,
    rename_session, ChatWriteRefusal, ClearProjectHistoryRequest, DeleteMessagesRequest,
    DeleteSessionRequest, RecordMessageMetadataRequest, RenameSessionRequest,
};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::{json, Map, Value};

const DIGEST: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const THINKING_METADATA: &str =
    r#"{"thinking_blocks":[{"type":"thinking","text":"t"}],"other":{"b":2,"a":1}}"#;

/// Two projects. `s1` (p1, scene-bound) has messages m1 (user, captured and
/// versioned), m2 (assistant, with thinking metadata) and m3 (system); `s2`
/// (p1) has m4; `s3` belongs to p2 and has m5.
fn fixture() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(&format!(
            "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, version)
               VALUES ('scene-1', 'p1', 'scene', 'Scene', 'a0', 0);
             INSERT INTO chat_sessions (id, project_id, node_id, title, model, created_at, updated_at)
               VALUES ('s1', 'p1', 'scene-1', 'First', 'm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                      ('s2', 'p1', NULL, 'Second', 'm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
                      ('s3', 'p2', NULL, 'Other', 'm', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
             INSERT INTO chat_messages (id, session_id, role, content, metadata, created_at)
               VALUES ('m1', 's1', 'user', 'question', NULL, '2026-01-01T00:00:01.000Z'),
                      ('m2', 's1', 'assistant', 'answer', '{THINKING_METADATA}', '2026-01-01T00:00:02.000Z'),
                      ('m3', 's1', 'system', 'note', '', '2026-01-01T00:00:03.000Z'),
                      ('m4', 's2', 'user', 'second', '{{\"keep\":true}}', '2026-01-01T00:00:04.000Z'),
                      ('m5', 's3', 'user', 'other', NULL, '2026-01-01T00:00:05.000Z');
             INSERT INTO chat_message_prompts (message_id, system_prompt) VALUES ('m2', 'p');
             INSERT INTO codex_entries (id, project_id, name, source_chat_message_id)
               VALUES ('codex-1', 'p1', 'Entry', 'm2');
             INSERT INTO chat_session_pinned_codex (id, session_id, codex_entry_id)
               VALUES ('pin-1', 's1', 'codex-1');
             INSERT INTO map_boards (id, project_id) VALUES ('board-1', 'p1');
             INSERT INTO map_stickies (id, board_id, body, source_chat_message_id)
               VALUES ('sticky-1', 'board-1', '{{}}', 'm2');
             INSERT INTO change_events (project_id, domain, op_type, entity_id, payload, session_id, sequence, timestamp, prev_hash, hash)
               VALUES ('p1', 'chat', 'chat.message.add', 'm1', '{{\"content\":\"question\"}}', 'timelapse', 1, 1, '', 'h');"
        ))?;
        Ok(())
    })
    .expect("seed chat fixture");
    // Only a Human row can carry a captured version.
    grimodex_db::nir1_generation::bind_human_message(&db, "p1", "s1", "m1", 1_790_000_000_000)
        .expect("bind m1 version");
    let version_id: String = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT id FROM nir1_generation_message_versions WHERE message_id = 'm1'",
                [],
                |row| row.get(0),
            )?)
        })
        .expect("m1 version");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO nir1_chat_input_captures
                (capture_id, project_id, chat_session_id, scene_id, submission_id,
                 submission_digest, message_id, message_version_id, owner_json, state, created_at_ms)
             VALUES ('capture-1', 'p1', 's1', 'scene-1', 'submission-1', ?1, 'm1', ?2, '{}',
                     'current', 1790000000000)",
            params![DIGEST, version_id],
        )?;
        Ok(())
    })
    .expect("seed capture");
    db
}

fn insert_attempt(db: &Database, id: &str, session: &str, terminal: bool) {
    db.with_conn(|conn| {
        let (terminal_json, terminal_digest, completed): (Option<&str>, Option<&str>, Option<i64>) =
            if terminal {
                (Some("{}"), Some("d"), Some(3))
            } else {
                (None, None, None)
            };
        conn.execute(
            "INSERT INTO nir1_generation_attempts
                (id, project_id, session_id, binding_json, payload_digest, input_digest,
                 created_at_ms, expires_at_ms, terminal_json, terminal_digest, completed_at_ms)
             VALUES (?1, 'p1', ?2, '{}', 'pd', 'id', 1, 2, ?3, ?4, ?5)",
            params![id, session, terminal_json, terminal_digest, completed],
        )?;
        Ok(())
    })
    .expect("seed attempt");
}

/// Every row the writers can touch, as text, for before/after comparisons.
fn dump(db: &Database) -> Vec<String> {
    let queries = [
        "SELECT id, project_id, node_id, codex_anchor_id, snippet_anchor_id, title, title_manual, model, created_at, updated_at FROM chat_sessions ORDER BY id",
        "SELECT id, session_id, role, content, metadata, created_at FROM chat_messages ORDER BY id",
        "SELECT message_id FROM chat_message_prompts ORDER BY message_id",
        "SELECT id, session_id FROM chat_session_pinned_codex ORDER BY id",
        "SELECT capture_id, message_id, state FROM nir1_chat_input_captures ORDER BY capture_id",
        "SELECT message_id, invalidated FROM nir1_generation_message_versions ORDER BY message_id",
        "SELECT id, source_chat_message_id FROM codex_entries ORDER BY id",
        "SELECT id, source_chat_message_id FROM map_stickies ORDER BY id",
        "SELECT id, session_id, terminal_json FROM nir1_generation_attempts ORDER BY id",
        "SELECT entity_id, op_type, payload FROM change_events ORDER BY sequence",
    ];
    db.with_conn(|conn| {
        let mut out = Vec::new();
        for sql in queries {
            let mut statement = conn.prepare(sql)?;
            let columns = statement.column_count();
            let rows = statement.query_map([], |row| {
                let mut cells = Vec::with_capacity(columns);
                for index in 0..columns {
                    let value: rusqlite::types::Value = row.get(index)?;
                    cells.push(format!("{value:?}"));
                }
                Ok(cells.join("|"))
            })?;
            for row in rows {
                out.push(format!("{sql}: {}", row?));
            }
        }
        Ok(out)
    })
    .expect("dump rows")
}

fn count(db: &Database, sql: &str) -> i64 {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |row| row.get(0))?))
        .expect("count")
}

fn scalar(db: &Database, sql: &str) -> Option<String> {
    db.with_conn(|conn| Ok(conn.query_row(sql, [], |row| row.get(0))?))
        .expect("scalar")
}

fn assert_refused<T: std::fmt::Debug>(result: anyhow::Result<T>, expected: ChatWriteRefusal) {
    let error = result.expect_err("expected a typed refusal");
    assert_eq!(refusal_of(&error), Some(expected), "{error:#}");
    assert_eq!(
        format!("{error}"),
        format!("CHAT_WRITE_REFUSED:{}", expected.code())
    );
}

fn delete_request(session: &str, ids: &[&str]) -> DeleteMessagesRequest {
    DeleteMessagesRequest {
        project_id: "p1".into(),
        session_id: session.into(),
        message_ids: ids.iter().map(|id| id.to_string()).collect(),
    }
}

fn patch(value: Value) -> Map<String, Value> {
    value.as_object().expect("patch object").clone()
}

#[test]
fn message_delete_follows_foreign_keys_and_canonical_triggers() {
    let db = fixture();
    let deleted = delete_messages(&db, delete_request("s1", &["m1", "m2", "missing"]))
        .expect("delete messages");
    assert_eq!(deleted.deleted, 2);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM chat_messages WHERE id IN ('m1','m2')"
        ),
        0
    );
    // Canonical triggers: capture removed, versions invalidated, provenance
    // nulled; foreign keys: prompt cascaded, sticky provenance SET NULL.
    assert_eq!(
        count(&db, "SELECT count(*) FROM nir1_chat_input_captures"),
        0
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM nir1_generation_message_versions WHERE invalidated = 0 AND message_id IN ('m1','m2')"),
        0
    );
    assert_eq!(
        scalar(&db, "SELECT source_chat_message_id FROM codex_entries"),
        None
    );
    assert_eq!(
        scalar(&db, "SELECT source_chat_message_id FROM map_stickies"),
        None
    );
    assert_eq!(count(&db, "SELECT count(*) FROM chat_message_prompts"), 0);
    // The timelapse copy and the surviving rows stay.
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM change_events WHERE op_type = 'chat.message.add'"
        ),
        1
    );
    assert_eq!(count(&db, "SELECT count(*) FROM chat_messages"), 3);
}

#[test]
fn session_delete_and_clear_cascade_and_keep_attempts_and_feed() {
    let db = fixture();
    insert_attempt(&db, "attempt-done", "s1", true);
    assert_eq!(
        delete_session(
            &db,
            DeleteSessionRequest {
                project_id: "p1".into(),
                session_id: "s1".into()
            }
        )
        .expect("delete session")
        .deleted,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM chat_messages WHERE session_id = 's1'"
        ),
        0
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM chat_session_pinned_codex"),
        0
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM nir1_chat_input_captures"),
        0
    );
    // Attempts have no foreign key to the session; the feed is not rewritten.
    assert_eq!(
        count(&db, "SELECT count(*) FROM nir1_generation_attempts"),
        1
    );
    assert_eq!(count(&db, "SELECT count(*) FROM change_events"), 1);

    let cleared = clear_project_history(
        &db,
        ClearProjectHistoryRequest {
            project_id: "p1".into(),
        },
    )
    .expect("clear history");
    assert_eq!(cleared.deleted_sessions, 1);
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM chat_sessions WHERE project_id = 'p1'"
        ),
        0
    );
    // The other project is untouched.
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM chat_sessions WHERE project_id = 'p2'"
        ),
        1
    );
    assert_eq!(
        count(&db, "SELECT count(*) FROM chat_messages WHERE id = 'm5'"),
        1
    );
}

#[test]
fn pending_attempt_refuses_every_deletion_and_deletes_nothing() {
    let db = fixture();
    insert_attempt(&db, "attempt-pending", "s1", false);
    let before = dump(&db);
    assert_refused(
        delete_messages(&db, delete_request("s1", &["m2"])),
        ChatWriteRefusal::GenerationPending,
    );
    assert_refused(
        delete_session(
            &db,
            DeleteSessionRequest {
                project_id: "p1".into(),
                session_id: "s1".into(),
            },
        ),
        ChatWriteRefusal::GenerationPending,
    );
    assert_refused(
        clear_project_history(
            &db,
            ClearProjectHistoryRequest {
                project_id: "p1".into(),
            },
        ),
        ChatWriteRefusal::GenerationPending,
    );
    assert_eq!(dump(&db), before, "a refused deletion must remove nothing");
    // Another session of the project and the other operations still work.
    assert_eq!(
        delete_messages(&db, delete_request("s2", &["m4"]))
            .expect("s2")
            .deleted,
        1
    );
    assert_eq!(
        rename_session(
            &db,
            RenameSessionRequest {
                project_id: "p1".into(),
                session_id: "s1".into(),
                title: "Renamed".into()
            }
        )
        .expect("rename while pending")
        .updated,
        1
    );
    assert_eq!(
        record_message_metadata(
            &db,
            RecordMessageMetadataRequest {
                project_id: "p1".into(),
                message_id: "m2".into(),
                patch: patch(json!({ "insertedToEditor": true })),
            }
        )
        .expect("record while pending")
        .updated,
        1
    );
}

#[test]
fn terminal_attempt_allows_deletion() {
    let db = fixture();
    insert_attempt(&db, "attempt-done", "s1", true);
    assert_eq!(
        delete_messages(&db, delete_request("s1", &["m3"]))
            .expect("delete")
            .deleted,
        1
    );
    assert_eq!(
        clear_project_history(
            &db,
            ClearProjectHistoryRequest {
                project_id: "p1".into()
            }
        )
        .expect("clear")
        .deleted_sessions,
        2
    );
}

#[test]
fn deletion_scope_is_bound_to_project_and_session() {
    let db = fixture();
    let before = dump(&db);
    // A message of another session, and of another project's session.
    assert_refused(
        delete_messages(&db, delete_request("s1", &["m2", "m4"])),
        ChatWriteRefusal::ScopeMismatch,
    );
    assert_refused(
        delete_messages(&db, delete_request("s3", &["m5"])),
        ChatWriteRefusal::ScopeMismatch,
    );
    assert_refused(
        delete_session(
            &db,
            DeleteSessionRequest {
                project_id: "p1".into(),
                session_id: "s3".into(),
            },
        ),
        ChatWriteRefusal::ScopeMismatch,
    );
    assert_refused(
        rename_session(
            &db,
            RenameSessionRequest {
                project_id: "p1".into(),
                session_id: "s3".into(),
                title: "x".into(),
            },
        ),
        ChatWriteRefusal::ScopeMismatch,
    );
    assert_refused(
        record_message_metadata(
            &db,
            RecordMessageMetadataRequest {
                project_id: "p1".into(),
                message_id: "m5".into(),
                patch: patch(json!({ "insertedToEditor": true })),
            },
        ),
        ChatWriteRefusal::ScopeMismatch,
    );
    assert_eq!(dump(&db), before);
    // Missing rows are not an error, as with the current generic SQL.
    assert_eq!(
        delete_session(
            &db,
            DeleteSessionRequest {
                project_id: "p1".into(),
                session_id: "gone".into()
            }
        )
        .expect("missing session")
        .deleted,
        0
    );
    assert_eq!(
        delete_messages(&db, delete_request("gone", &["also-gone"]))
            .expect("missing")
            .deleted,
        0
    );
}

#[test]
fn writers_reject_invalid_requests_without_writing() {
    let db = fixture();
    let before = dump(&db);
    assert_refused(
        delete_messages(&db, delete_request("s1", &[])),
        ChatWriteRefusal::InvalidRequest,
    );
    let too_many: Vec<String> = (0..257).map(|index| format!("id-{index}")).collect();
    assert_refused(
        delete_messages(
            &db,
            DeleteMessagesRequest {
                project_id: "p1".into(),
                session_id: "s1".into(),
                message_ids: too_many,
            },
        ),
        ChatWriteRefusal::InvalidRequest,
    );
    assert_refused(
        delete_messages(&db, delete_request("s1", &[""])),
        ChatWriteRefusal::InvalidRequest,
    );
    assert_refused(
        rename_session(
            &db,
            RenameSessionRequest {
                project_id: "p1".into(),
                session_id: "s1".into(),
                title: "x".repeat(4097),
            },
        ),
        ChatWriteRefusal::InvalidRequest,
    );
    assert_refused(
        clear_project_history(
            &db,
            ClearProjectHistoryRequest {
                project_id: String::new(),
            },
        ),
        ChatWriteRefusal::InvalidRequest,
    );
    for bad in [
        json!({}),
        json!({ "extractedCodex": "codex-1" }),
        json!({ "extractedCodex": [1] }),
        json!({ "extractedSnippets": [""] }),
        json!({ "insertedToEditor": "yes" }),
    ] {
        assert_refused(
            record_message_metadata(
                &db,
                RecordMessageMetadataRequest {
                    project_id: "p1".into(),
                    message_id: "m2".into(),
                    patch: patch(bad),
                },
            ),
            ChatWriteRefusal::InvalidRequest,
        );
    }
    assert_eq!(dump(&db), before);
}

#[test]
fn rename_writes_only_title_manual_and_updated_at() {
    let db = fixture();
    let before = dump(&db);
    let updated = rename_session(
        &db,
        RenameSessionRequest {
            project_id: "p1".into(),
            session_id: "s1".into(),
            title: "新しい題".into(),
        },
    )
    .expect("rename");
    assert_eq!(updated.updated, 1);
    let row: (String, i64, String, Option<String>, String, String) = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT title, title_manual, updated_at, node_id, model, created_at FROM chat_sessions WHERE id = 's1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )?)
        })
        .expect("read session");
    assert_eq!(row.0, "新しい題");
    assert_eq!(row.1, 1);
    // `Date.prototype.toISOString()` shape.
    assert_eq!(row.2.len(), 24, "{}", row.2);
    assert!(
        row.2.ends_with('Z') && row.2.as_bytes()[10] == b'T',
        "{}",
        row.2
    );
    assert_eq!(
        (row.3.as_deref(), row.4.as_str(), row.5.as_str()),
        (Some("scene-1"), "m", "2026-01-01T00:00:00.000Z")
    );
    // Nothing else changed: messages, versions, captures.
    let after = dump(&db);
    let unchanged = |rows: &[String]| -> Vec<String> {
        rows.iter()
            .filter(|row| !row.starts_with("SELECT id, project_id, node_id"))
            .cloned()
            .collect()
    };
    assert_eq!(unchanged(&after), unchanged(&before));
}

#[test]
fn metadata_record_keeps_other_keys_and_message_versions() {
    let db = fixture();
    let updated = record_message_metadata(
        &db,
        RecordMessageMetadataRequest {
            project_id: "p1".into(),
            message_id: "m2".into(),
            patch: patch(json!({ "extractedCodex": ["codex-1"], "insertedToEditor": true })),
        },
    )
    .expect("record");
    assert_eq!(updated.updated, 1);
    // The same text as the renderer's JSON.stringify({ ...existing, ...update }).
    assert_eq!(
        scalar(&db, "SELECT metadata FROM chat_messages WHERE id = 'm2'").as_deref(),
        Some(
            r#"{"thinking_blocks":[{"type":"thinking","text":"t"}],"other":{"b":2,"a":1},"extractedCodex":["codex-1"],"insertedToEditor":true}"#
        )
    );
    // Replacing an existing key keeps its position.
    record_message_metadata(
        &db,
        RecordMessageMetadataRequest {
            project_id: "p1".into(),
            message_id: "m2".into(),
            patch: patch(json!({ "extractedCodex": ["codex-2", "codex-3"] })),
        },
    )
    .expect("replace record");
    assert_eq!(
        scalar(&db, "SELECT metadata FROM chat_messages WHERE id = 'm2'").as_deref(),
        Some(
            r#"{"thinking_blocks":[{"type":"thinking","text":"t"}],"other":{"b":2,"a":1},"extractedCodex":["codex-2","codex-3"],"insertedToEditor":true}"#
        )
    );
    // NULL and '' start from an empty object.
    for message in ["m1", "m3"] {
        record_message_metadata(
            &db,
            RecordMessageMetadataRequest {
                project_id: "p1".into(),
                message_id: message.into(),
                patch: patch(json!({ "extractedSnippets": ["snippet-1"] })),
            },
        )
        .expect("record on empty metadata");
        assert_eq!(
            scalar(
                &db,
                &format!("SELECT metadata FROM chat_messages WHERE id = '{message}'")
            )
            .as_deref(),
            Some(r#"{"extractedSnippets":["snippet-1"]}"#)
        );
    }
    // The record never invalidates a message version (CW condition 2).
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM nir1_generation_message_versions WHERE invalidated = 1"
        ),
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT count(*) FROM nir1_chat_input_captures WHERE state = 'current'"
        ),
        1
    );
    // A missing message updates nothing, as before.
    assert_eq!(
        record_message_metadata(
            &db,
            RecordMessageMetadataRequest {
                project_id: "p1".into(),
                message_id: "gone".into(),
                patch: patch(json!({ "insertedToEditor": true })),
            }
        )
        .expect("missing message")
        .updated,
        0
    );
}

#[test]
fn metadata_record_rejects_other_keys_without_writing() {
    let db = fixture();
    let before = dump(&db);
    for bad in [
        json!({ "thinking_blocks": [] }),
        json!({ "insertedToEditor": true, "role": "assistant" }),
        json!({ "keep": false }),
    ] {
        assert_refused(
            record_message_metadata(
                &db,
                RecordMessageMetadataRequest {
                    project_id: "p1".into(),
                    message_id: "m2".into(),
                    patch: patch(bad),
                },
            ),
            ChatWriteRefusal::MetadataKeyNotAllowed,
        );
    }
    assert_eq!(dump(&db), before, "a refused record must write nothing");
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE chat_messages SET metadata = '[1]' WHERE id = 'm4'",
            [],
        )?;
        Ok(())
    })
    .expect("seed non-object metadata");
    assert_refused(
        record_message_metadata(
            &db,
            RecordMessageMetadataRequest {
                project_id: "p1".into(),
                message_id: "m4".into(),
                patch: patch(json!({ "insertedToEditor": true })),
            },
        ),
        ChatWriteRefusal::MetadataUnreadable,
    );
    assert_eq!(
        scalar(&db, "SELECT metadata FROM chat_messages WHERE id = 'm4'").as_deref(),
        Some("[1]")
    );
}

#[test]
fn no_writer_inserts_a_row() {
    let db = fixture();
    let sessions = count(&db, "SELECT count(*) FROM chat_sessions");
    let messages = count(&db, "SELECT count(*) FROM chat_messages");
    rename_session(
        &db,
        RenameSessionRequest {
            project_id: "p1".into(),
            session_id: "missing".into(),
            title: "t".into(),
        },
    )
    .expect("rename missing");
    record_message_metadata(
        &db,
        RecordMessageMetadataRequest {
            project_id: "p1".into(),
            message_id: "missing".into(),
            patch: patch(json!({ "insertedToEditor": false })),
        },
    )
    .expect("record missing");
    delete_messages(&db, delete_request("s1", &["missing"])).expect("delete missing");
    assert_eq!(count(&db, "SELECT count(*) FROM chat_sessions"), sessions);
    assert_eq!(count(&db, "SELECT count(*) FROM chat_messages"), messages);
    // The surviving message rows keep their identity columns.
    assert_eq!(
        count(&db, "SELECT count(*) FROM chat_messages WHERE (id, session_id, role, content) IN (VALUES ('m1','s1','user','question'),('m2','s1','assistant','answer'),('m3','s1','system','note'),('m4','s2','user','second'),('m5','s3','user','other'))"),
        5
    );
}

#[test]
fn results_are_counts_only() {
    let db = fixture();
    let wire = [
        serde_json::to_value(delete_messages(&db, delete_request("s1", &["m3"])).expect("delete"))
            .expect("wire"),
        serde_json::to_value(
            rename_session(
                &db,
                RenameSessionRequest {
                    project_id: "p1".into(),
                    session_id: "s2".into(),
                    title: "t".into(),
                },
            )
            .expect("rename"),
        )
        .expect("wire"),
        serde_json::to_value(
            clear_project_history(
                &db,
                ClearProjectHistoryRequest {
                    project_id: "p2".into(),
                },
            )
            .expect("clear"),
        )
        .expect("wire"),
    ];
    assert_eq!(
        wire,
        [
            json!({ "deleted": 1 }),
            json!({ "updated": 1 }),
            json!({ "deletedSessions": 1 })
        ]
    );
}

/// D-11 (a): on an unrestricted profile the typed writers leave the same rows
/// as the renderer's current generic SQL (the timestamp of the rename aside).
#[test]
fn typed_writers_match_the_current_generic_sql_results() {
    type Generic = fn(&Database);
    type Typed = fn(&Database);
    let cases: [(&str, Generic, Typed); 5] = [
        (
            "deleteMessage",
            |db| {
                for id in ["m1", "m2"] {
                    db.execute_renderer(
                        "DELETE FROM chat_messages WHERE id = ?",
                        &[Value::from(id)],
                        "run",
                    )
                    .expect("generic delete");
                }
            },
            |db| {
                delete_messages(db, delete_request("s1", &["m1", "m2"])).expect("typed delete");
            },
        ),
        (
            "deleteSession",
            |db| {
                db.execute_renderer(
                    "DELETE FROM chat_sessions WHERE id = ?",
                    &[Value::from("s1")],
                    "run",
                )
                .expect("generic session delete");
            },
            |db| {
                delete_session(
                    db,
                    DeleteSessionRequest {
                        project_id: "p1".into(),
                        session_id: "s1".into(),
                    },
                )
                .expect("typed session delete");
            },
        ),
        (
            "clearProjectChatHistory",
            |db| {
                db.execute_renderer(
                    "DELETE FROM chat_sessions WHERE project_id = ?",
                    &[Value::from("p1")],
                    "run",
                )
                .expect("generic clear");
            },
            |db| {
                clear_project_history(
                    db,
                    ClearProjectHistoryRequest {
                        project_id: "p1".into(),
                    },
                )
                .expect("typed clear");
            },
        ),
        (
            "updateSessionTitle",
            |db| {
                db.execute_renderer(
                    "UPDATE chat_sessions SET title = ?, title_manual = ?, updated_at = ? WHERE id = ?",
                    &[Value::from("Renamed"), Value::from(1), Value::from("T"), Value::from("s1")],
                    "run",
                )
                .expect("generic rename");
            },
            |db| {
                rename_session(
                    db,
                    RenameSessionRequest {
                        project_id: "p1".into(),
                        session_id: "s1".into(),
                        title: "Renamed".into(),
                    },
                )
                .expect("typed rename");
                db.with_conn(|conn| {
                    conn.execute(
                        "UPDATE chat_sessions SET updated_at = 'T' WHERE id = 's1'",
                        [],
                    )?;
                    Ok(())
                })
                .expect("normalize timestamp");
            },
        ),
        (
            "updateMessageMetadata",
            |db| {
                // The renderer's merge: JSON.stringify({ ...existing, ...update }).
                let merged = r#"{"thinking_blocks":[{"type":"thinking","text":"t"}],"other":{"b":2,"a":1},"extractedSnippets":["snippet-1"]}"#;
                db.execute_renderer(
                    "UPDATE chat_messages SET metadata = ? WHERE id = ?",
                    &[Value::from(merged), Value::from("m2")],
                    "run",
                )
                .expect("generic metadata");
            },
            |db| {
                record_message_metadata(
                    db,
                    RecordMessageMetadataRequest {
                        project_id: "p1".into(),
                        message_id: "m2".into(),
                        patch: patch(json!({ "extractedSnippets": ["snippet-1"] })),
                    },
                )
                .expect("typed metadata");
            },
        ),
    ];
    for (name, generic, typed) in cases {
        let current = fixture();
        let next = fixture();
        generic(&current);
        typed(&next);
        assert_eq!(dump(&next), dump(&current), "{name}");
    }
}
