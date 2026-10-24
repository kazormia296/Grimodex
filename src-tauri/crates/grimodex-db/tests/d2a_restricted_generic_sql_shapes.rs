//! NIR-1 DA-2b (ST4-A, DR-DA2-50): which generic-SQL shapes of the M and T
//! features break under the restricted D2a authorizer, measured on the real
//! current schema through the same entry the Electron Native `db_execute`
//! uses for a restricted profile (`execute_renderer_profile_egress`).
//!
//! The measurement decides which features get a typed Native writer (the
//! ones that stay broken without RETURNING) and which only drop RETURNING and
//! re-read in the renderer (K3/2 "M と T の対処の規則" 1, D-12 (a)).

#[path = "../test-support/adapter.rs"]
mod test_support;

use grimodex_db::Database;
use serde_json::Value;

const DENIED: &str = "D2A_EGRESS_DENIED";

fn fixture() -> Database {
    let db = test_support::current_schema_memory().expect("current-schema fixture");
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'One');
             INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, version)
               VALUES ('scene-1', 'p1', 'scene', 'Scene', 'a0', 0);
             INSERT INTO codex_entries (id, project_id, name) VALUES ('codex-1', 'p1', 'Entry');
             INSERT INTO chat_sessions (id, project_id, title) VALUES ('session-1', 'p1', 'S');
             INSERT INTO chat_messages (id, session_id, role, content)
               VALUES ('message-1', 'session-1', 'user', 'hello');
             INSERT INTO chat_session_pinned_codex (id, session_id, codex_entry_id)
               VALUES ('pin-1', 'session-1', 'codex-1');
             INSERT INTO map_boards (id, project_id) VALUES ('board-1', 'p1');
             INSERT INTO map_stickies (id, board_id, body)
               VALUES ('sticky-0', 'board-1', '{}');
             INSERT INTO labels (id, project_id, name, color) VALUES ('label-0', 'p1', 'L0', '#000');
             INSERT INTO prompt_templates (id, project_id) VALUES ('prompt-0', 'p1');
             INSERT INTO content_versions (id, entity_type, entity_id, content, version_number)
               VALUES ('version-1', 'scene', 'scene-1', '{}', 1);
             INSERT INTO project_snapshots (id, project_id, name) VALUES ('snapshot-1', 'p1', 'Snap');
             INSERT INTO project_snapshot_entries (snapshot_id, version_id)
               VALUES ('snapshot-1', 'version-1');
             INSERT INTO impact_review_baselines (entry_id, project_id, snapshot_json, content_hash)
               VALUES ('codex-1', 'p1', '{}', 'h0');",
        )?;
        Ok(())
    })
    .expect("seed database");
    db
}

fn restricted(db: &Database, sql: &str) -> Result<(), String> {
    db.execute_renderer_profile_egress(sql, &[] as &[Value], "run")
        .map(|_| ())
        .map_err(|error| format!("{error:#}"))
}

fn restricted_with(db: &Database, sql: &str, params: &[Value]) -> Result<(), String> {
    db.execute_renderer_profile_egress(sql, params, "run")
        .map(|_| ())
        .map_err(|error| format!("{error:#}"))
}

fn assert_passes(db: &Database, sql: &str) {
    if let Err(error) = restricted(db, sql) {
        panic!("expected the restricted generic SQL to pass: {sql}\n{error}");
    }
}

fn assert_denied(db: &Database, sql: &str) {
    match restricted(db, sql) {
        Ok(()) => panic!("expected the restricted generic SQL to be denied: {sql}"),
        Err(error) => assert!(error.contains(DENIED), "{sql}: {error}"),
    }
}

#[test]
fn map_sticky_dml_passes_without_returning_and_fails_with_it() {
    let db = fixture();
    // createSticky / updateSticky / deleteSticky without RETURNING. The FK
    // parent `chat_messages` is read-open, so its authorizer read passes.
    assert_passes(
        &db,
        "INSERT INTO map_stickies (id, board_id, body, source_chat_message_id)
         VALUES ('sticky-1', 'board-1', '{}', 'message-1')",
    );
    assert_passes(
        &db,
        "UPDATE map_stickies SET title = 't', updated_at = 'now' WHERE id = 'sticky-1'",
    );
    assert_passes(
        &db,
        "UPDATE map_stickies SET source_chat_message_id = 'message-1' WHERE id = 'sticky-0'",
    );
    assert_passes(&db, "DELETE FROM map_stickies WHERE id = 'sticky-1'");
    // The current shape (Drizzle `.returning()`) is what breaks.
    assert_denied(
        &db,
        "INSERT INTO map_stickies (id, board_id, body) VALUES ('sticky-2', 'board-1', '{}') RETURNING *",
    );
    assert_denied(
        &db,
        "UPDATE map_stickies SET title = 'u' WHERE id = 'sticky-0' RETURNING *",
    );
}

#[test]
fn pin_children_toggle_passes_without_returning() {
    let db = fixture();
    assert_passes(
        &db,
        "UPDATE chat_session_pinned_codex SET with_children = 1
          WHERE session_id = 'session-1' AND codex_entry_id = 'codex-1'",
    );
    assert_denied(
        &db,
        "UPDATE chat_session_pinned_codex SET with_children = 0
          WHERE session_id = 'session-1' AND codex_entry_id = 'codex-1' RETURNING *",
    );
}

#[test]
fn labels_prompt_templates_and_map_tables_pass_without_returning() {
    let db = fixture();
    for sql in [
        "INSERT INTO labels (id, project_id, name, color) VALUES ('label-1', 'p1', 'L1', '#fff')",
        "UPDATE labels SET name = 'L2' WHERE id = 'label-1'",
        "INSERT INTO prompt_templates (id, project_id, title, content) VALUES ('prompt-1', 'p1', 't', 'c')",
        "UPDATE prompt_templates SET usage_count = usage_count + 1 WHERE id = 'prompt-1'",
        "INSERT INTO map_boards (id, project_id, title) VALUES ('board-2', 'p1', 'B')",
        "UPDATE map_boards SET title = 'C' WHERE id = 'board-2'",
        "INSERT INTO map_node_positions (id, board_id, node_ref_type, sticky_id, x, y)
         VALUES ('pos-1', 'board-1', 'sticky', 'sticky-0', 0, 0)",
        "INSERT INTO map_node_positions (id, board_id, node_ref_type, tree_node_id, x, y)
         VALUES ('pos-2', 'board-1', 'scene', 'scene-1', 1, 1)",
        "UPDATE map_node_positions SET x = 2 WHERE id = 'pos-2'",
        "INSERT INTO map_edges (id, board_id, from_position_id, to_position_id)
         VALUES ('edge-1', 'board-1', 'pos-1', 'pos-2')",
        "UPDATE map_edges SET color = '#ffffff' WHERE id = 'edge-1'",
        "INSERT INTO map_frames (id, board_id, x, y, width, height)
         VALUES ('frame-1', 'board-1', 0, 0, 10, 10)",
        "UPDATE map_frames SET title = 'F' WHERE id = 'frame-1'",
    ] {
        assert_passes(&db, sql);
    }
    for sql in [
        "INSERT INTO labels (id, project_id, name, color) VALUES ('label-3', 'p1', 'L3', '#fff') RETURNING *",
        "UPDATE prompt_templates SET title = 'x' WHERE id = 'prompt-0' RETURNING *",
        "INSERT INTO map_boards (id, project_id) VALUES ('board-3', 'p1') RETURNING *",
    ] {
        assert_denied(&db, sql);
    }
}

#[test]
fn read_open_and_cascading_dml_stay_denied_and_need_typed_writers() {
    let db = fixture();
    // M: version recording and pruning write the read-open `content_versions`.
    assert_denied(
        &db,
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number)
         VALUES ('version-2', 'scene', 'scene-1', '{}', 2)",
    );
    assert_denied(&db, "DELETE FROM content_versions WHERE id = 'version-1'");
    // M: deleting a snapshot cascades into the read-open snapshot child tables.
    assert_denied(&db, "DELETE FROM project_snapshots WHERE id = 'snapshot-1'");
    // T: the Impact Review baseline is read-open, with or without RETURNING.
    assert_denied(
        &db,
        "UPDATE impact_review_baselines SET snapshot_json = '{}', content_hash = 'h1'
          WHERE entry_id = 'codex-1' AND content_hash = 'h0'",
    );
    // CW: every chat write stays closed to generic SQL.
    for sql in [
        "DELETE FROM chat_messages WHERE id = 'message-1'",
        "DELETE FROM chat_sessions WHERE id = 'session-1'",
        "DELETE FROM chat_sessions WHERE project_id = 'p1'",
        "UPDATE chat_sessions SET title = 'x', title_manual = 1 WHERE id = 'session-1'",
        "UPDATE chat_messages SET metadata = '{}' WHERE id = 'message-1'",
    ] {
        assert_denied(&db, sql);
    }
    // Nothing above changed a row.
    let counts = db
        .with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT (SELECT count(*) FROM content_versions),
                        (SELECT count(*) FROM project_snapshots),
                        (SELECT content_hash FROM impact_review_baselines),
                        (SELECT count(*) FROM chat_messages),
                        (SELECT title FROM chat_sessions)",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )?)
        })
        .expect("count rows");
    assert_eq!(counts, (1, 1, "h0".to_string(), 1, "S".to_string()));
}

/// The exact statements Drizzle generates for the product calls, without
/// their `.returning()` (review P2-3 (ii) and P3-1; DR-DA2-55). Generated on
/// 2026-10-25 with drizzle-orm 0.45 (`sqlite-proxy`, the renderer's client)
/// from the same builders as `mapApi.ts` `createSticky` / `adoptSticky` and
/// `chatApi.ts` `pinCodexEntry` (both conflict branches), `togglePinChildren`
/// and `unpinCodexEntry` (K3/2 "chat の書込みの入口" 10 and 11). Every
/// statement is one `db_execute` call (none of them goes through a batch).
#[test]
fn the_product_drizzle_statements_pass_without_returning() {
    let db = fixture();
    db.with_conn(|conn| {
        conn.execute_batch(
            "INSERT INTO codex_entries (id, project_id, name) VALUES ('codex-2', 'p1', 'Second');",
        )?;
        Ok(())
    })
    .expect("seed a second Codex entry");
    let sticky_insert = r#"insert into "map_stickies" ("id", "board_id", "title", "body", "preview_text", "palette_id", "color_slot", "ai_branch_id", "ai_derived", "source_chat_message_id", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"#;
    let sticky = |id: &str, source: Value| {
        vec![
            Value::from(id),
            Value::from("board-1"),
            Value::Null,
            Value::from(r#"{"type":"doc","content":[]}"#),
            Value::Null,
            Value::from("default"),
            Value::from(0),
            Value::Null,
            Value::from(0),
            source,
            Value::from("2026-10-25T00:00:00.000Z"),
            Value::from("2026-10-25T00:00:00.000Z"),
        ]
    };
    let pin_insert = r#"insert into "chat_session_pinned_codex" ("id", "session_id", "codex_entry_id", "snippet_id", "sticky_id", "with_children", "pin_source", "created_at") values (?, ?, ?, ?, ?, ?, ?, ?)"#;
    let pin_manual = format!(
        r#"{pin_insert} on conflict ("chat_session_pinned_codex"."session_id", "chat_session_pinned_codex"."codex_entry_id") where "chat_session_pinned_codex"."codex_entry_id" is not null do update set "with_children" = ?, "pin_source" = ?"#
    );
    let pin_mention = format!("{pin_insert} on conflict do nothing");
    let pin = |id: &str, source: &str, extra: &[Value]| {
        let mut values = vec![
            Value::from(id),
            Value::from("session-1"),
            Value::from("codex-2"),
            Value::Null,
            Value::Null,
            Value::from(0),
            Value::from(source),
            Value::from("2026-10-25T00:00:00.000Z"),
        ];
        values.extend_from_slice(extra);
        values
    };
    let adopt = r#"update "map_stickies" set "ai_branch_id" = ?, "updated_at" = ? where "map_stickies"."id" = ?"#;
    let toggle = r#"update "chat_session_pinned_codex" set "with_children" = ? where ("chat_session_pinned_codex"."session_id" = ? and "chat_session_pinned_codex"."codex_entry_id" = ?)"#;
    let unpin = r#"delete from "chat_session_pinned_codex" where ("chat_session_pinned_codex"."session_id" = ? and ("chat_session_pinned_codex"."codex_entry_id" = ? or "chat_session_pinned_codex"."snippet_id" = ? or "chat_session_pinned_codex"."sticky_id" = ?))"#;
    let steps: Vec<(&str, String, Vec<Value>)> = vec![
        (
            "createSticky",
            sticky_insert.to_string(),
            sticky("sticky-d1", Value::Null),
        ),
        (
            "createSticky (chat source)",
            sticky_insert.to_string(),
            sticky("sticky-d2", Value::from("message-1")),
        ),
        (
            "adoptSticky",
            adopt.to_string(),
            vec![
                Value::Null,
                Value::from("2026-10-25T00:00:01.000Z"),
                Value::from("sticky-d1"),
            ],
        ),
        (
            "pinCodexEntry (manual, new row)",
            pin_manual.clone(),
            pin("pin-d1", "manual", &[Value::from(0), Value::from("manual")]),
        ),
        (
            "pinCodexEntry (manual, conflict: do update)",
            pin_manual,
            pin("pin-d3", "manual", &[Value::from(1), Value::from("manual")]),
        ),
        (
            "pinCodexEntry (chat_mention, conflict: do nothing)",
            pin_mention,
            pin("pin-d2", "chat_mention", &[]),
        ),
    ];
    for (name, sql, params) in &steps {
        if let Err(error) = restricted_with(&db, sql, params) {
            panic!("{name}: expected the restricted generic SQL to pass\n{error}");
        }
    }
    let rows = |sql: &str| -> String {
        db.with_conn(|conn| Ok(conn.query_row(sql, [], |row| row.get::<_, String>(0))?))
            .expect("re-read")
    };
    assert_eq!(
        rows("SELECT group_concat(id || ':' || coalesce(source_chat_message_id, '-') || ':' || coalesce(ai_branch_id, '-'), ',') FROM (SELECT * FROM map_stickies WHERE id LIKE 'sticky-d%' ORDER BY id)"),
        "sticky-d1:-:-,sticky-d2:message-1:-"
    );
    // One pin row: the conflicts updated it (do update) and kept it (do nothing).
    let pin_row = || {
        rows("SELECT group_concat(id || ':' || with_children || ':' || pin_source, ',') FROM chat_session_pinned_codex WHERE codex_entry_id = 'codex-2'")
    };
    assert_eq!(pin_row(), "pin-d1:1:manual");
    if let Err(error) = restricted_with(
        &db,
        toggle,
        &[
            Value::from(0),
            Value::from("session-1"),
            Value::from("codex-2"),
        ],
    ) {
        panic!("togglePinChildren: expected the restricted generic SQL to pass\n{error}");
    }
    assert_eq!(pin_row(), "pin-d1:0:manual");
    if let Err(error) = restricted_with(
        &db,
        unpin,
        &[
            Value::from("session-1"),
            Value::from("codex-2"),
            Value::from("codex-2"),
            Value::from("codex-2"),
        ],
    ) {
        panic!("unpinCodexEntry: expected the restricted generic SQL to pass\n{error}");
    }
    assert_eq!(
        rows("SELECT CAST(count(*) AS TEXT) FROM chat_session_pinned_codex WHERE codex_entry_id = 'codex-2'"),
        "0"
    );
    // The current shapes, with Drizzle's RETURNING, are what breaks.
    for (sql, params) in [
        (
            format!("{sticky_insert} returning \"id\""),
            sticky("sticky-d4", Value::Null),
        ),
        (
            format!("{adopt} returning \"id\""),
            vec![Value::Null, Value::from("now"), Value::from("sticky-d2")],
        ),
        (
            format!("{toggle} returning \"id\""),
            vec![
                Value::from(1),
                Value::from("session-1"),
                Value::from("codex-1"),
            ],
        ),
    ] {
        match restricted_with(&db, &sql, &params) {
            Ok(()) => panic!("expected RETURNING to be denied: {sql}"),
            Err(error) => assert!(error.contains(DENIED), "{sql}: {error}"),
        }
    }
}
