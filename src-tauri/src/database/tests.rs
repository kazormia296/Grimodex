use super::*;

fn test_db() -> Database {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("migrate");
    db
}

/// Insert a `default-chapter` folder for tests that historically relied
/// on it being seeded by the schema.
fn seed_default_chapter(db: &Database) {
    db.execute(
        "INSERT OR IGNORE INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) \
         VALUES ('default-chapter', 'default-project', 'folder', 'Part.1', 'a0', datetime('now'), datetime('now'))",
        &[],
        "run",
    )
    .expect("seed default-chapter");
}

#[test]
fn test_migrate_creates_all_tables() {
    let db = test_db();
    let expected_tables = [
        "projects",
        "tree_nodes",
        "codex_entries",
        "codex_dismissed_relations",
        "snippets",
        "chat_sessions",
        "chat_messages",
        "generation_logs",
        "ai_usage",
        "authorship_spans",
        "app_settings",
        "project_settings",
        "foreshadows",
        "foreshadow_setups",
        "foreshadow_codex_links",
        "scene_chunks",
    ];
    for table in &expected_tables {
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                &[Value::String((*table).into())],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1, "table '{}' should exist", table);
    }
}

/// N4: ai_usage への insert→select round-trip。`src/features/ai-usage/
/// recordAiUsage.ts` が drizzle 経由で書く「正確な列セット」を SQLite に直接
/// 流して通ることを保証する。recordAiUsage は fail-open (記録失敗を握りつぶす)
/// なので、schema.ts ↔ migrate.rs の列ドリフトはモック化された TS テストでは
/// silent に機能を殺す。この test が唯一その drift を捕まえる。
#[test]
fn test_ai_usage_insert_roundtrip_matches_recordai_columns() {
    let db = test_db();
    // FK: ai_usage.project_id REFERENCES projects(id)
    db.execute(
        "INSERT INTO projects (id, title, created_at, updated_at) \
         VALUES ('p1', 'P', datetime('now'), datetime('now'))",
        &[],
        "run",
    )
    .expect("seed project");

    // recordAiUsage が書く列セットと完全一致させること。
    db.execute(
        "INSERT INTO ai_usage \
         (id, project_id, surface, scene_node_id, model, provider, \
          tokens_in, tokens_out, cost_usd, duration_ms, trace_id, ref_id, \
          metadata, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            serde_json::json!("u1"),
            serde_json::json!("p1"),
            serde_json::json!("chat"),
            Value::Null, // scene_node_id
            serde_json::json!("claude-sonnet-4-6"),
            serde_json::json!("openrouter"),
            serde_json::json!(1000),   // tokens_in
            serde_json::json!(500),    // tokens_out
            serde_json::json!(0.0123), // cost_usd (REAL)
            serde_json::json!(4200),   // duration_ms
            serde_json::json!("trace-1"),
            serde_json::json!("ref-1"),
            Value::Null, // metadata
            serde_json::json!("2026-06-05T00:00:00Z"),
        ],
        "run",
    )
    .expect("insert ai_usage row (column set must match migrate.rs DDL)");

    let rows = db
        .execute(
            "SELECT surface, tokens_in, tokens_out, cost_usd \
             FROM ai_usage WHERE project_id = ?",
            &[serde_json::json!("p1")],
            "all",
        )
        .expect("select ai_usage");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["surface"], serde_json::json!("chat"));
    assert_eq!(rows[0]["tokens_in"], Value::Number(1000.into()));
    assert_eq!(rows[0]["tokens_out"], Value::Number(500.into()));

    // null トークン行 (streaming で usage 未到達) も記録できること。
    db.execute(
        "INSERT INTO ai_usage (id, project_id, surface, created_at) \
         VALUES ('u2', 'p1', 'inline_ai', datetime('now'))",
        &[],
        "run",
    )
    .expect("insert unmetered ai_usage row");
    let all = db
        .execute(
            "SELECT id FROM ai_usage WHERE project_id = ?",
            &[serde_json::json!("p1")],
            "all",
        )
        .expect("select all");
    assert_eq!(all.len(), 2);
}

#[test]
fn test_migrate_generation_logs_and_trace_id_idempotent() {
    let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
    db.migrate().expect("first migrate");
    db.migrate().expect("second migrate");

    let span_cols = db
        .execute("PRAGMA table_info('authorship_spans')", &[], "all")
        .expect("pragma authorship_spans");
    let span_col_names: Vec<String> = span_cols
        .iter()
        .filter_map(|row| match &row["name"] {
            Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    assert!(
        span_col_names.contains(&"trace_id".to_string()),
        "authorship_spans.trace_id should exist"
    );

    let log_rows = db
        .execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='generation_logs'",
            &[],
            "all",
        )
        .expect("query generation_logs");
    assert_eq!(log_rows.len(), 1);

    let log_cols = db
        .execute("PRAGMA table_info('generation_logs')", &[], "all")
        .expect("pragma generation_logs");
    let log_col_names: Vec<String> = log_cols
        .iter()
        .filter_map(|row| match &row["name"] {
            Value::String(s) => Some(s.clone()),
            _ => None,
        })
        .collect();
    for col in [
        "id",
        "project_id",
        "scene_node_id",
        "kind",
        "command_id",
        "instruction",
        "prompt_full",
        "model",
        "trace_id",
        "created_at",
    ] {
        assert!(
            log_col_names.contains(&col.to_string()),
            "generation_logs.{col} should exist"
        );
    }
}

#[test]
fn test_migrate_creates_fts_tables() {
    let db = test_db();
    let expected = [
        "codex_fts",
        "snippets_fts",
        "chat_messages_fts",
        "tree_nodes_fts",
    ];
    for table in &expected {
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
                &[Value::String((*table).into())],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1, "FTS table '{}' should exist", table);
    }
}

#[test]
fn test_migrate_creates_beat_columns() {
    let db = test_db();
    let cols = db
        .execute("PRAGMA table_info('tree_nodes')", &[], "all")
        .expect("pragma");
    let names: Vec<String> = cols
        .iter()
        .filter_map(|row| {
            if let Value::String(s) = &row["name"] {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    assert!(
        names.contains(&"unplaced_beats_doc".to_string()),
        "unplaced_beats_doc column should exist"
    );
    assert!(
        names.contains(&"char_count".to_string()),
        "char_count column should exist"
    );
}

#[test]
fn test_add_column_if_missing_adds_then_skips() {
    // Direct test of the helper: legacy table → add column → existing rows
    // get the default → second call is a no-op.
    let db = Database::new(Path::new(":memory:")).expect("open");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "CREATE TABLE legacy (id TEXT PRIMARY KEY);
             INSERT INTO legacy (id) VALUES ('row1');",
        )
        .expect("seed");

        Database::add_column_if_missing(&conn, "legacy", "new_col", "INTEGER NOT NULL DEFAULT 7")
            .expect("first add");
        // Idempotency: a second call must be a no-op (no error, no duplicate column).
        Database::add_column_if_missing(&conn, "legacy", "new_col", "INTEGER NOT NULL DEFAULT 7")
            .expect("second add is noop");
    }

    let cols = db
        .execute("PRAGMA table_info('legacy')", &[], "all")
        .expect("pragma");
    let new_col_count = cols
        .iter()
        .filter(|row| row["name"] == Value::String("new_col".into()))
        .count();
    assert_eq!(new_col_count, 1, "column should appear exactly once");

    let rows = db
        .execute("SELECT new_col FROM legacy WHERE id='row1'", &[], "all")
        .expect("select");
    assert_eq!(rows[0]["new_col"], Value::from(7));
}

#[test]
fn test_migrate_stickies_color_to_palette_slot() {
    // Build a legacy DB by hand (old `color` column), then migrate and
    // verify the table is rebuilt with palette_id/color_slot and the
    // existing color enum is mapped to the right slot index.
    let db = Database::new(Path::new(":memory:")).expect("open");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "CREATE TABLE map_boards (id TEXT PRIMARY KEY);
             CREATE TABLE map_ai_branches (id TEXT PRIMARY KEY);
             CREATE TABLE chat_messages (id TEXT PRIMARY KEY);
             INSERT INTO map_boards (id) VALUES ('b1');
             CREATE TABLE map_stickies (
                id          TEXT PRIMARY KEY,
                board_id    TEXT NOT NULL REFERENCES map_boards(id) ON DELETE CASCADE,
                title       TEXT,
                body        TEXT NOT NULL DEFAULT '{\"type\":\"doc\",\"content\":[]}',
                preview_text TEXT,
                color       TEXT NOT NULL DEFAULT 'yellow'
                              CHECK(color IN ('yellow','orange','pink','green','blue','purple','gray','white')),
                ai_branch_id TEXT,
                source_chat_message_id TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
             );
             INSERT INTO map_stickies (id, board_id, color) VALUES ('s_y', 'b1', 'yellow');
             INSERT INTO map_stickies (id, board_id, color) VALUES ('s_p', 'b1', 'purple');
             INSERT INTO map_stickies (id, board_id, color) VALUES ('s_g', 'b1', 'gray');",
        )
        .expect("seed legacy");

        Database::migrate_stickies_color_to_palette_slot(&conn).expect("migrate");
    }

    let cols = db
        .execute("PRAGMA table_info('map_stickies')", &[], "all")
        .expect("pragma");
    let names: Vec<String> = cols
        .iter()
        .filter_map(|row| {
            if let Value::String(s) = &row["name"] {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    assert!(
        !names.contains(&"color".to_string()),
        "legacy color column should be dropped"
    );
    assert!(names.contains(&"palette_id".to_string()));
    assert!(names.contains(&"color_slot".to_string()));

    let rows = db
        .execute(
            "SELECT id, palette_id, color_slot FROM map_stickies ORDER BY id",
            &[],
            "all",
        )
        .expect("select");
    // s_g (gray) → 0, s_p (purple) → 5, s_y (yellow) → 0
    assert_eq!(rows[0]["id"], Value::from("s_g"));
    assert_eq!(rows[0]["color_slot"], Value::from(0));
    assert_eq!(rows[0]["palette_id"], Value::from("post-it-playful"));
    assert_eq!(rows[1]["id"], Value::from("s_p"));
    assert_eq!(rows[1]["color_slot"], Value::from(5));
    assert_eq!(rows[2]["id"], Value::from("s_y"));
    assert_eq!(rows[2]["color_slot"], Value::from(0));
}

#[test]
fn test_migrate_stickies_color_to_palette_slot_idempotent() {
    // Already-new schema: migrate is a no-op.
    let db = test_db(); // already has new schema (no `color` column)
    let conn = db.conn.lock().expect("lock");
    Database::migrate_stickies_color_to_palette_slot(&conn).expect("noop");
}

#[test]
fn test_migrate_creates_pov_location_columns() {
    let db = test_db();
    let cols = db
        .execute("PRAGMA table_info('tree_nodes')", &[], "all")
        .expect("pragma");
    let names: Vec<String> = cols
        .iter()
        .filter_map(|row| {
            if let Value::String(s) = &row["name"] {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    assert!(
        names.contains(&"pov_character_id".to_string()),
        "pov_character_id column should exist"
    );
    assert!(
        names.contains(&"location_id".to_string()),
        "location_id column should exist"
    );
}

#[test]
fn test_seed_data() {
    let db = test_db();
    let projects = db
        .execute("SELECT * FROM projects", &[], "all")
        .expect("select");
    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0]["id"], Value::String("default-project".into()));
    assert_eq!(projects[0]["language"], Value::String("ja".into()));

    // Fresh workspace must start with no folders/scenes so the user
    // can opt into structure (or use a template) instead of having a
    // placeholder Part.1 folder forced on them.
    let nodes = db
        .execute("SELECT * FROM tree_nodes", &[], "all")
        .expect("select");
    assert!(nodes.is_empty(), "tree_nodes should not be auto-seeded");
}

#[test]
fn test_crud_projects() {
    let db = test_db();

    db.execute(
        "INSERT INTO projects (id, title, genre, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("proj-1".into()),
            Value::String("Test Novel".into()),
            Value::String("fantasy".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let rows = db
        .execute("SELECT * FROM projects", &[], "all")
        .expect("select all");
    assert_eq!(rows.len(), 2); // seed + test

    let rows = db
        .execute(
            "SELECT * FROM projects WHERE id = ?",
            &[Value::String("proj-1".into())],
            "get",
        )
        .expect("select one");
    assert_eq!(rows[0]["title"], Value::String("Test Novel".into()));
    assert_eq!(rows[0]["genre"], Value::String("fantasy".into()));

    db.execute(
        "UPDATE projects SET title = ? WHERE id = ?",
        &[
            Value::String("Updated Novel".into()),
            Value::String("proj-1".into()),
        ],
        "run",
    )
    .expect("update");

    let rows = db
        .execute(
            "SELECT * FROM projects WHERE id = ?",
            &[Value::String("proj-1".into())],
            "get",
        )
        .expect("select after update");
    assert_eq!(rows[0]["title"], Value::String("Updated Novel".into()));

    db.execute(
        "DELETE FROM projects WHERE id = ?",
        &[Value::String("proj-1".into())],
        "run",
    )
    .expect("delete");

    let rows = db
        .execute("SELECT * FROM projects", &[], "all")
        .expect("select after delete");
    assert_eq!(rows.len(), 1); // seed remains
}

#[test]
fn test_crud_tree_nodes() {
    let db = test_db();
    seed_default_chapter(&db);

    // Create a scene under the default chapter
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("scene-1".into()),
            Value::String("default-project".into()),
            Value::String("default-chapter".into()),
            Value::String("scene".into()),
            Value::String("Opening".into()),
            Value::String("a0".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert scene node");

    let rows = db
        .execute(
            "SELECT * FROM tree_nodes WHERE parent_id = ?",
            &[Value::String("default-chapter".into())],
            "all",
        )
        .expect("select children");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], Value::String("Opening".into()));
    assert_eq!(rows[0]["node_type"], Value::String("scene".into()));

    // Update
    db.execute(
        "UPDATE tree_nodes SET title = ? WHERE id = ?",
        &[
            Value::String("Prologue".into()),
            Value::String("scene-1".into()),
        ],
        "run",
    )
    .expect("update");

    let rows = db
        .execute(
            "SELECT title FROM tree_nodes WHERE id = ?",
            &[Value::String("scene-1".into())],
            "get",
        )
        .expect("get");
    assert_eq!(rows[0]["title"], Value::String("Prologue".into()));
}

#[test]
fn test_cascade_delete_project_to_nodes() {
    let db = test_db();

    db.execute(
        "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        &[
            Value::String("proj-del".into()),
            Value::String("Deletable".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert project");

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ch-del".into()),
            Value::String("proj-del".into()),
            Value::String("folder".into()),
            Value::String("Ch1".into()),
            Value::String("a0".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert folder");

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("sc-del".into()),
            Value::String("proj-del".into()),
            Value::String("ch-del".into()),
            Value::String("scene".into()),
            Value::String("S1".into()),
            Value::String("a1".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert scene");

    db.execute(
        "DELETE FROM projects WHERE id = ?",
        &[Value::String("proj-del".into())],
        "run",
    )
    .expect("delete project");

    let nodes = db
        .execute(
            "SELECT * FROM tree_nodes WHERE project_id = ?",
            &[Value::String("proj-del".into())],
            "all",
        )
        .expect("select nodes");
    assert_eq!(nodes.len(), 0);
}

#[test]
fn test_crud_codex_entries() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("codex-1".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("太郎".into()),
            Value::String("主人公".into()),
            Value::String(r#"["主人公","勇者"]"#.into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let rows = db
        .execute("SELECT * FROM codex_entries", &[], "all")
        .expect("select all");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], Value::String("太郎".into()));

    db.execute(
        "UPDATE codex_entries SET summary = ? WHERE id = ?",
        &[
            Value::String("更新された主人公".into()),
            Value::String("codex-1".into()),
        ],
        "run",
    )
    .expect("update");

    let rows = db
        .execute(
            "SELECT summary FROM codex_entries WHERE id = ?",
            &[Value::String("codex-1".into())],
            "get",
        )
        .expect("get");
    assert_eq!(rows[0]["summary"], Value::String("更新された主人公".into()));

    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[Value::String("codex-1".into())],
        "run",
    )
    .expect("delete");

    let rows = db
        .execute("SELECT * FROM codex_entries", &[], "all")
        .expect("select after delete");
    assert_eq!(rows.len(), 0);
}

#[test]
fn test_crud_snippets() {
    let db = test_db();

    db.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("snip-1".into()),
            Value::String("default-project".into()),
            Value::String("伏線メモ".into()),
            Value::String("第3章で回収する伏線。".into()),
            Value::String(r#"["伏線"]"#.into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let rows = db
        .execute("SELECT * FROM snippets", &[], "all")
        .expect("select all");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], Value::String("伏線メモ".into()));

    db.execute(
        "UPDATE snippets SET title = ? WHERE id = ?",
        &[
            Value::String("更新されたメモ".into()),
            Value::String("snip-1".into()),
        ],
        "run",
    )
    .expect("update");

    let rows = db
        .execute(
            "SELECT title FROM snippets WHERE id = ?",
            &[Value::String("snip-1".into())],
            "get",
        )
        .expect("get");
    assert_eq!(rows[0]["title"], Value::String("更新されたメモ".into()));
}

#[test]
fn test_crud_chat_sessions_and_messages() {
    let db = test_db();

    db.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("sess-1".into()),
            Value::String("default-project".into()),
            Value::String("Test Session".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert session");

    let rows = db
        .execute("SELECT * FROM chat_sessions", &[], "all")
        .expect("select sessions");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], Value::String("Test Session".into()));

    db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("msg-1".into()),
            Value::String("sess-1".into()),
            Value::String("user".into()),
            Value::String("Hello".into()),
            Value::Null,
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert message");

    db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("msg-2".into()),
            Value::String("sess-1".into()),
            Value::String("assistant".into()),
            Value::String("Hi there!".into()),
            Value::String("claude-sonnet".into()),
            Value::String("2025-01-01T00:00:01Z".into()),
        ],
        "run",
    )
    .expect("insert assistant message");

    let rows = db
        .execute(
            "SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at",
            &[Value::String("sess-1".into())],
            "all",
        )
        .expect("select messages");
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["role"], Value::String("user".into()));
    assert_eq!(rows[1]["model"], Value::String("claude-sonnet".into()));
}

#[test]
fn test_chat_messages_role_check_constraint() {
    let db = test_db();

    db.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("sess-1".into()),
            Value::String("default-project".into()),
            Value::String("Test".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert session");

    let result = db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("msg-bad".into()),
            Value::String("sess-1".into()),
            Value::String("invalid_role".into()),
            Value::String("test".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    );
    assert!(result.is_err());
}

#[test]
fn test_cascade_delete_session_to_messages() {
    let db = test_db();

    db.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("sess-1".into()),
            Value::String("default-project".into()),
            Value::String("Test".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert session");

    db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("msg-1".into()),
            Value::String("sess-1".into()),
            Value::String("user".into()),
            Value::String("Hello".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert message");

    db.execute(
        "DELETE FROM chat_sessions WHERE id = ?",
        &[Value::String("sess-1".into())],
        "run",
    )
    .expect("delete session");

    let msgs = db
        .execute("SELECT * FROM chat_messages", &[], "all")
        .expect("select messages");
    assert_eq!(msgs.len(), 0);
}

#[test]
fn test_crud_settings() {
    let db = test_db();

    db.execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        &[
            Value::String("editor.fontSize".into()),
            Value::String("16".into()),
        ],
        "run",
    )
    .expect("insert setting");

    let rows = db
        .execute(
            "SELECT value FROM app_settings WHERE key = ?",
            &[Value::String("editor.fontSize".into())],
            "get",
        )
        .expect("get setting");
    assert_eq!(rows[0]["value"], Value::String("16".into()));

    db.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)",
        &[
            Value::String("editor.fontSize".into()),
            Value::String("18".into()),
        ],
        "run",
    )
    .expect("update setting");

    let rows = db
        .execute(
            "SELECT value FROM app_settings WHERE key = ?",
            &[Value::String("editor.fontSize".into())],
            "get",
        )
        .expect("get updated setting");
    assert_eq!(rows[0]["value"], Value::String("18".into()));
}

#[test]
fn test_fts5_codex_search() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c1".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("太郎".into()),
            Value::String("勇敢な主人公".into()),
            Value::String(r#"["主人公","勇者"]"#.into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c2".into()),
            Value::String("default-project".into()),
            Value::String("location".into()),
            Value::String("魔王城".into()),
            Value::String("最終ダンジョン".into()),
            Value::String(r#"["ダンジョン"]"#.into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    // Search by summary
    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("勇敢な主人公".into())],
            "all",
        )
        .expect("fts search");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], Value::String("太郎".into()));

    // Search by name
    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("魔王城".into())],
            "all",
        )
        .expect("fts search");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["name"], Value::String("魔王城".into()));
}

#[test]
fn test_fts5_codex_search_matches_body_content() {
    // codex_fts must index the ProseMirror body `content`, not just
    // name/aliases/summary/tags_cache. A writer's distinctive body word
    // (here 主席卒業) lives only in `content`, so a fresh-DB search for it
    // must surface the entry.
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c-body".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("セレーナ".into()),
            Value::String("幼なじみの魔法導師".into()),
            Value::String("[]".into()),
            Value::String(
                r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"学院を主席卒業し古代魔法を解読した才媛。"}]}]}"#
                    .into(),
            ),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    // 主席卒業 appears only in the body content, not name/summary/tags.
    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("主席卒業".into())],
            "all",
        )
        .expect("fts search by body content");
    assert_eq!(
        rows.len(),
        1,
        "body word should match via codex_fts content"
    );
    assert_eq!(rows[0]["name"], Value::String("セレーナ".into()));
}

#[test]
fn test_migrate_codex_fts_add_content_upgrades_legacy() {
    // Simulate a legacy DB whose codex_fts predates the `content` column, then
    // run the migration: existing rows must be re-indexed so body words become
    // searchable, and re-running must be a no-op.
    let db = test_db();
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS codex_fts_ai;
             DROP TRIGGER IF EXISTS codex_fts_ad;
             DROP TRIGGER IF EXISTS codex_fts_au;
             DROP TABLE IF EXISTS codex_fts;
             CREATE VIRTUAL TABLE codex_fts USING fts5(
                 name, aliases, summary, tags_cache,
                 content=codex_entries, content_rowid=rowid,
                 tokenize='trigram'
             );
             CREATE TRIGGER codex_fts_ai AFTER INSERT ON codex_entries BEGIN
                 INSERT INTO codex_fts(rowid, name, aliases, summary, tags_cache)
                 VALUES (new.rowid, COALESCE(new.name, ''), COALESCE(new.aliases, ''), COALESCE(new.summary, ''), COALESCE(new.tags_cache, ''));
             END;
             CREATE TRIGGER codex_fts_ad AFTER DELETE ON codex_entries BEGIN
                 INSERT INTO codex_fts(codex_fts, rowid, name, aliases, summary, tags_cache)
                 VALUES ('delete', old.rowid, COALESCE(old.name, ''), COALESCE(old.aliases, ''), COALESCE(old.summary, ''), COALESCE(old.tags_cache, ''));
             END;",
        )
        .expect("seed legacy codex_fts");
    }

    // Inserted under the legacy schema → body content is not indexed yet.
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c-legacy".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("ヴェルズ".into()),
            Value::String("廃墟の主".into()),
            Value::String("[]".into()),
            Value::String(
                r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"主人公の父と因縁を持つ千年の番人。"}]}]}"#
                    .into(),
            ),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert legacy");

    let before = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("千年の番人".into())],
            "all",
        )
        .expect("fts before migrate");
    assert_eq!(before.len(), 0, "legacy schema must not index body content");

    {
        let conn = db.conn.lock().expect("lock");
        Database::migrate_codex_fts_add_content(&conn).expect("migrate");
        // Idempotent: a second run is a no-op.
        Database::migrate_codex_fts_add_content(&conn).expect("noop second run");
    }

    let cols = db
        .execute("PRAGMA table_info('codex_fts')", &[], "all")
        .expect("pragma");
    let names: Vec<String> = cols
        .iter()
        .filter_map(|row| {
            if let Value::String(s) = &row["name"] {
                Some(s.clone())
            } else {
                None
            }
        })
        .collect();
    assert!(
        names.contains(&"content".to_string()),
        "codex_fts should gain a content column"
    );

    // The pre-existing row was re-indexed by the 'rebuild' command.
    let after = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("千年の番人".into())],
            "all",
        )
        .expect("fts after migrate");
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["name"], Value::String("ヴェルズ".into()));
}

#[test]
fn test_search_fts_codex_like_matches_content() {
    // The search_fts codex LIKE fallback (short, <3 codepoint query) must also
    // match body content — mirroring the FTS path and the scene LIKE branch.
    // 共鳴 (2 codepoints) lives only in the body, so it exercises the fallback.
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c-like".into()),
            Value::String("default-project".into()),
            Value::String("lore".into()),
            Value::String("古代魔法システム".into()),
            Value::String("失われた術の体系".into()),
            Value::String("[]".into()),
            Value::String(
                r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"感情が共鳴すると出力が増幅し暴走する。"}]}]}"#
                    .into(),
            ),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let hits = db
        .search_fts("default-project", "共鳴", "codex", 20)
        .expect("search_fts");
    assert_eq!(
        hits.len(),
        1,
        "short body word should hit via codex LIKE fallback"
    );
    assert_eq!(hits[0]["title"].as_str(), Some("古代魔法システム"));
}

#[test]
fn test_search_fts_en_project_stems_query() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'she was studying hard');",
        )
        .expect("seed");
    }
    // "studies" (a different surface form) must find the "studying" scene.
    let results = db
        .search_fts("p_en", "studies", "scenes", 10)
        .expect("search");
    assert_eq!(
        results.len(),
        1,
        "porter-stemmed query hits the inflected body"
    );
    assert_eq!(results[0]["id"], serde_json::json!("s1"));
}

#[test]
#[ignore = "measurement: run with --ignored to print trigram vs _en recall"]
fn measure_en_fts_recall_trigram_vs_porter() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    // A handful of scenes with inflected vocabulary, plus an en and a ja project.
    let scenes: &[(&str, &str)] = &[
        ("s1", "the soldiers were studying old maps by candlelight"),
        ("s2", "she studies the ledger and decides to leave"),
        ("s3", "horses galloped while the riders shouted"),
        ("s4", "he noticed the broken lock and the cold draft"),
        ("s5", "they kept running through the burning streets"),
    ];
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en')",
            [],
        )
        .expect("en project");
        for (id, body) in scenes {
            conn.execute(
                "INSERT INTO tree_nodes(id, project_id, node_type, title, content)
                 VALUES (?1, 'p_en', 'scene', 'S', ?2)",
                rusqlite::params![id, body],
            )
            .expect("scene");
        }
    }
    // Query (stemmed/base form) -> the scene id it should retrieve.
    let queries: &[(&str, &str)] = &[
        ("study", "s1"),  // study -> studying
        ("decide", "s2"), // decide -> decides
        ("gallop", "s3"), // gallop -> galloped
        ("notice", "s4"), // notice -> noticed
        ("run", "s5"),    // run -> running (len 3: see note below)
    ];
    let mut en_hits = 0;
    for (q, want) in queries {
        let found = db
            .search_fts("p_en", q, "scenes", 10)
            .expect("search")
            .iter()
            .any(|r| r["id"] == serde_json::json!(*want));
        if found {
            en_hits += 1;
        }
    }
    // Note: "run" is 3 codepoints and survives the sanitizer; 1-2 char queries
    // are dropped by to_fts_match for both tokenizers (documented limitation).
    println!(
        "[eval] _en (porter unicode61) recall: {}/{} inflected queries",
        en_hits,
        queries.len()
    );
    // Sanity floor: stemming should retrieve clearly inflected matches.
    assert!(
        en_hits >= 4,
        "expected porter stemming to recall >=4/5 inflected queries"
    );
}

#[test]
fn test_fts5_snippets_search() {
    let db = test_db();

    db.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("s1".into()),
            Value::String("default-project".into()),
            Value::String("森の描写".into()),
            Value::String("暗い森の中、一筋の光が差し込んだ。".into()),
            Value::String(r#"["描写","森"]"#.into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let rows = db
        .execute(
            "SELECT title FROM snippets_fts WHERE snippets_fts MATCH ?",
            &[Value::String("森の描写".into())],
            "all",
        )
        .expect("fts search");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["title"], Value::String("森の描写".into()));
}

#[test]
fn test_fts5_chat_messages_search() {
    let db = test_db();

    db.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("sess-fts".into()),
            Value::String("default-project".into()),
            Value::String("FTS Test".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert session");

    db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("msg-fts".into()),
            Value::String("sess-fts".into()),
            Value::String("user".into()),
            Value::String("太郎のキャラクター設定について教えてください".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert message");

    let rows = db
        .execute(
            "SELECT content FROM chat_messages_fts WHERE chat_messages_fts MATCH ?",
            &[Value::String("キャラクター設定".into())],
            "all",
        )
        .expect("fts search");
    assert_eq!(rows.len(), 1);
}

#[test]
fn test_fts5_sync_on_update() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c-upd".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("山田太郎".into()),
            Value::String("主人公キャラ".into()),
            Value::String("[]".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    db.execute(
        "UPDATE codex_entries SET name = ? WHERE id = ?",
        &[
            Value::String("鈴木次郎".into()),
            Value::String("c-upd".into()),
        ],
        "run",
    )
    .expect("update");

    // Old name should not match
    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("山田太郎".into())],
            "all",
        )
        .expect("fts search old");
    assert_eq!(rows.len(), 0);

    // New name should match
    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("鈴木次郎".into())],
            "all",
        )
        .expect("fts search new");
    assert_eq!(rows.len(), 1);
}

#[test]
fn test_fts5_sync_on_delete() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("c-del".into()),
            Value::String("default-project".into()),
            Value::String("item".into()),
            Value::String("伝説の聖剣".into()),
            Value::String("伝説の武器".into()),
            Value::String("[]".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert");

    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("伝説の聖剣".into())],
            "all",
        )
        .expect("fts before delete");
    assert_eq!(rows.len(), 1);

    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[Value::String("c-del".into())],
        "run",
    )
    .expect("delete");

    let rows = db
        .execute(
            "SELECT name FROM codex_fts WHERE codex_fts MATCH ?",
            &[Value::String("伝説の聖剣".into())],
            "all",
        )
        .expect("fts after delete");
    assert_eq!(rows.len(), 0);
}

#[test]
fn test_en_fts_triggers_route_and_stem() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    db.migrate().expect("re-migrate is idempotent");

    let conn = db.conn.lock().expect("lock");
    conn.execute_batch(
        "INSERT INTO projects(id, title, language) VALUES
           ('p_en', 'En Project', 'en'),
           ('p_ja', 'Ja Project', 'ja');
         INSERT INTO tree_nodes(id, project_id, node_type, title, content) VALUES
           ('s_en', 'p_en', 'scene', 'Ch1', 'she was studying hard'),
           ('s_ja', 'p_ja', 'scene', 'Sho1', 'plain japanese body');",
    )
    .expect("seed rows");

    // Incremental trigger indexed ONLY the English scene into _en, and porter
    // stems the query "studies" to match the indexed "studying".
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"studies\""],
            |r| r.get(0),
        )
        .expect("match query");
    assert_eq!(
        hits, 1,
        "only the en scene is in _en and porter stems studies==studying"
    );
}

#[test]
fn test_rebuild_en_fts_repopulates_after_wipe() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'they kept running home');
             DELETE FROM tree_nodes_fts_en;",
        )
        .expect("seed + wipe _en");
        let after_wipe: i64 = conn
            .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
            .expect("count");
        assert_eq!(after_wipe, 0, "wipe emptied _en");
    }

    db.rebuild_en_fts().expect("rebuild");

    let conn = db.conn.lock().expect("lock");
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"runs\""],
            |r| r.get(0),
        )
        .expect("match");
    assert_eq!(
        hits, 1,
        "rebuild re-indexed the en scene; porter stems runs==running"
    );
}

/// Regression (DB health audit 2026-07, C1): the `_en` FTS AFTER DELETE triggers
/// used to be language-guarded via a subquery on the parent row (projects). On
/// an FK cascade the parent is deleted first, so the guard evaluated NULL, the
/// trigger didn't fire, and the `_en` index row was orphaned — then a later
/// insert that reused the rowid failed with a duplicate-rowid constraint. The
/// unguarded delete triggers must remove the row on cascade.
#[test]
fn test_en_fts_no_orphan_on_cascade_delete() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    let conn = db.conn.lock().expect("lock");

    conn.execute_batch(
        "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
         INSERT INTO tree_nodes(id, project_id, node_type, title, content)
           VALUES ('s1', 'p_en', 'scene', 'Ch1', 'hello world content');",
    )
    .expect("seed en scene");
    let before: i64 = conn
        .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
        .expect("count before");
    assert_eq!(before, 1, "en scene indexed into _en");

    // Cascade-delete via the parent project. The old guarded trigger would not
    // fire (parent already gone), leaving an orphan.
    conn.execute("DELETE FROM projects WHERE id = 'p_en'", [])
        .expect("delete project");
    let orphans: i64 = conn
        .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
        .expect("count after");
    assert_eq!(
        orphans, 0,
        "cascade delete must not leave an _en FTS orphan"
    );

    // Rowid reuse: a fresh en scene reuses the freed rowid; a lingering orphan
    // would make the trigger's INSERT fail with a duplicate-rowid constraint.
    conn.execute_batch(
        "INSERT INTO projects(id, title, language) VALUES ('p_en2', 'En2', 'en');
         INSERT INTO tree_nodes(id, project_id, node_type, title, content)
           VALUES ('s2', 'p_en2', 'scene', 'Ch2', 'more content here');",
    )
    .expect("reinsert after cascade must not hit a duplicate rowid");
    let reindexed: i64 = conn
        .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
        .expect("count reindexed");
    assert_eq!(reindexed, 1, "new en scene indexed cleanly after cascade");
}

#[test]
fn test_nullify_codex_source_on_message_delete() {
    let db = test_db();

    // Create session + message
    db.execute(
        "INSERT INTO chat_sessions (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("s1".into()), Value::String("default-project".into()), Value::String("Session".into())],
        "run",
    ).expect("insert session");
    db.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
        &[Value::String("msg1".into()), Value::String("s1".into()), Value::String("user".into()), Value::String("hello".into())],
        "run",
    ).expect("insert message");

    // Create codex entry referencing the message
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("cx1".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("テスト".into()), Value::String("msg1".into())],
        "run",
    ).expect("insert codex");

    // Delete the message
    db.execute(
        "DELETE FROM chat_messages WHERE id = ?",
        &[Value::String("msg1".into())],
        "run",
    )
    .expect("delete message");

    // Verify source was nullified
    let rows = db
        .execute(
            "SELECT source_chat_message_id FROM codex_entries WHERE id = ?",
            &[Value::String("cx1".into())],
            "all",
        )
        .expect("query");
    assert_eq!(rows[0]["source_chat_message_id"], Value::Null);
}

#[test]
fn test_nullify_snippet_scene_on_node_delete() {
    let db = test_db();
    seed_default_chapter(&db);

    // Create scene node
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("sc1".into()), Value::String("default-project".into()), Value::String("default-chapter".into()), Value::String("scene".into()), Value::String("シーン1".into()), Value::String("a1".into())],
        "run",
    ).expect("insert scene node");

    // Create snippet referencing the scene
    db.execute(
        "INSERT INTO snippets (id, project_id, title, scene_id, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("sn1".into()), Value::String("default-project".into()), Value::String("テスト".into()), Value::String("sc1".into())],
        "run",
    ).expect("insert snippet");

    // Delete the scene node
    db.execute(
        "DELETE FROM tree_nodes WHERE id = ?",
        &[Value::String("sc1".into())],
        "run",
    )
    .expect("delete scene node");

    // Verify scene_id was nullified
    let rows = db
        .execute(
            "SELECT scene_id FROM snippets WHERE id = ?",
            &[Value::String("sn1".into())],
            "all",
        )
        .expect("query");
    assert_eq!(rows[0]["scene_id"], Value::Null);
}

/// Regression: deleting a folder whose child scene has a content_version
/// referenced by a project_snapshot used to fail with
/// `FOREIGN KEY constraint failed` because `delete_cv_on_tree_node_delete`
/// tried to drop the snapshot-protected version (RESTRICT FK on
/// project_snapshot_entries.version_id). The trigger must skip those rows so
/// the snapshot keeps pointing at preserved version data while unprotected
/// versions are cleaned up.
#[test]
fn test_delete_tree_node_preserves_snapshot_protected_versions() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    db.execute(
        "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
        &[p("snap-proj"), p("Snap")],
        "run",
    ).expect("insert project");

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, 'folder', 'Part 1', 'a0', datetime('now'), datetime('now'))",
        &[p("snap-part1"), p("snap-proj")],
        "run",
    ).expect("insert folder");

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, 'scene', 'Scene 1', 'a1', datetime('now'), datetime('now'))",
        &[p("snap-scene1"), p("snap-proj"), p("snap-part1")],
        "run",
    ).expect("insert scene");

    // Two versions for the same scene: v-protected referenced by a snapshot,
    // v-orphan not referenced (should be cleaned up by the trigger).
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'scene', ?, '{}', 1, 'auto', datetime('now'))",
        &[p("v-protected"), p("snap-scene1")],
        "run",
    ).expect("insert protected version");
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'scene', ?, '{}', 2, 'auto', datetime('now'))",
        &[p("v-orphan"), p("snap-scene1")],
        "run",
    ).expect("insert orphan version");

    db.execute(
        "INSERT INTO project_snapshots (id, project_id, name, created_at) VALUES (?, ?, ?, datetime('now'))",
        &[p("snap-1"), p("snap-proj"), p("第一部・初稿")],
        "run",
    ).expect("insert snapshot");
    db.execute(
        "INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES (?, ?)",
        &[p("snap-1"), p("v-protected")],
        "run",
    )
    .expect("insert snapshot entry");

    // Delete the folder; cascade hits the scene and the cv-cleanup trigger.
    // Pre-fix this returned FOREIGN KEY constraint failed on v-protected.
    db.execute(
        "DELETE FROM tree_nodes WHERE id = ?",
        &[p("snap-part1")],
        "run",
    )
    .expect("delete folder");

    let nodes = db
        .execute(
            "SELECT id FROM tree_nodes WHERE project_id = ?",
            &[p("snap-proj")],
            "all",
        )
        .expect("query nodes");
    assert_eq!(nodes.len(), 0, "folder and scene should be gone");

    let versions = db
        .execute(
            "SELECT id FROM content_versions WHERE entity_id = ? ORDER BY id",
            &[p("snap-scene1")],
            "all",
        )
        .expect("query versions");
    assert_eq!(
        versions.len(),
        1,
        "only the snapshot-protected version should survive"
    );
    assert_eq!(versions[0]["id"], Value::String("v-protected".into()));

    // Snapshot entry must still point at the protected version.
    let entries = db
        .execute(
            "SELECT version_id FROM project_snapshot_entries WHERE snapshot_id = ?",
            &[p("snap-1")],
            "all",
        )
        .expect("query entries");
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]["version_id"],
        Value::String("v-protected".into())
    );
}

/// End-to-end check for the structural-restore transaction:
/// `defer_foreign_keys = ON` lets us wipe tree_nodes and re-insert in a
/// single transaction even though the restored row references a codex
/// entry that gets inserted later in the same transaction, and the
/// `delete_cv_on_tree_node_delete` trigger fires (and skips the
/// snapshot-protected content_version) during the wipe.
#[test]
fn test_defer_foreign_keys_wipe_and_restore_round_trip() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, 'default-project', 'character', 'X', datetime('now'), datetime('now'))",
        &[p("cx-1")],
        "run",
    ).expect("insert codex");
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, pov_character_id, content, created_at, updated_at) VALUES (?, 'default-project', 'scene', 'S', 'a0', ?, '{}', datetime('now'), datetime('now'))",
        &[p("sc-1"), p("cx-1")],
        "run",
    ).expect("insert scene");
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'scene', 'sc-1', '{}', 1, 'auto', datetime('now'))",
        &[p("v-1")],
        "run",
    ).expect("insert version");
    db.execute(
        "INSERT INTO project_snapshots (id, project_id, name, created_at) VALUES (?, 'default-project', ?, datetime('now'))",
        &[p("snap-1"), p("checkpoint")],
        "run",
    ).expect("insert snapshot");
    db.execute(
        "INSERT INTO project_snapshot_tree_nodes (snapshot_id, node_id, node_type, title, sort_order, body_version_id, pov_character_id) VALUES (?, 'sc-1', 'scene', 'S', 'a0', ?, 'cx-1')",
        &[p("snap-1"), p("v-1")],
        "run",
    ).expect("insert snapshot tree node");

    // Wipe + restore as one transaction. Deliberately INSERT the scene
    // *before* the codex to prove the deferred check is at COMMIT time.
    let stmts = vec![
        crate::database::BatchStatement {
            sql: "PRAGMA defer_foreign_keys = ON".into(),
            params: vec![],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "DELETE FROM tree_nodes WHERE project_id = ?".into(),
            params: vec![p("default-project")],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, pov_character_id, content, created_at, updated_at) VALUES (?, 'default-project', 'scene', 'S', 'a0', ?, '{}', datetime('now'), datetime('now'))".into(),
            params: vec![p("sc-1"), p("cx-1")],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "INSERT OR REPLACE INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, 'default-project', 'character', 'X', datetime('now'), datetime('now'))".into(),
            params: vec![p("cx-1")],
            method: "run".into(),
        },
    ];
    db.execute_batch_tx(&stmts).expect("structural restore");

    let scenes = db
        .execute("SELECT id FROM tree_nodes WHERE id = 'sc-1'", &[], "all")
        .expect("query");
    assert_eq!(scenes.len(), 1);
    let versions = db
        .execute(
            "SELECT id FROM content_versions WHERE id = 'v-1'",
            &[],
            "all",
        )
        .expect("query");
    assert_eq!(versions.len(), 1);
}

/// 案B (AI tree scaffold/再編) の最重要不変条件を実 SQLite で検証する。
/// group(既存シーンを新規フォルダ配下へ移動)を単一 composite undo で巻き戻すとき、
/// undo の statement 順序は「(先)既存ノード復元 → (後)作成ノード削除」でなければ
/// `parent_id ... ON DELETE CASCADE`(migrate.rs:29)により既存シーンが巻き添え
/// 削除される。restore-先 / delete-後 の順序で既存シーンが生存することを確認。
/// applyPlan.ts buildUndoStatements がこの順序を組む。
#[test]
fn test_ai_tree_group_undo_preserves_existing_scene() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    // 既存シーン S を root に作る。
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, 'default-project', NULL, 'scene', 'Keep', 'a0', datetime('now'), datetime('now'))",
        &[p("sc-keep")],
        "run",
    ).expect("insert existing scene");

    // forward = group: 新フォルダ G 作成 + S を G 配下へ move。
    // INSERT は content/unplaced_beats_doc/char_count を省略し DB DEFAULT に委ねる
    // (buildForwardStatements と同じ列集合)。成功自体が NOT NULL 違反の不在を示す。
    let forward = vec![
        crate::database::BatchStatement {
            sql: "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, 'default-project', NULL, 'folder', 'G', 'a1', datetime('now'), datetime('now'))".into(),
            params: vec![p("g-new")],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "UPDATE tree_nodes SET parent_id = ?, sort_order = 'a0', updated_at = datetime('now') WHERE id = ?".into(),
            params: vec![p("g-new"), p("sc-keep")],
            method: "run".into(),
        },
    ];
    db.execute_batch_tx(&forward).expect("forward group");

    // 省略列が DB DEFAULT で埋まり、NOT NULL 違反にならなかったことを確認。
    let g = db
        .execute(
            "SELECT content FROM tree_nodes WHERE id = 'g-new'",
            &[],
            "get",
        )
        .expect("get g");
    assert_eq!(g.len(), 1, "new folder should exist");
    assert_ne!(
        g[0]["content"],
        Value::Null,
        "omitted content column should fall back to its DB DEFAULT"
    );

    // cascade-safe undo: (先) S を root へ復元 → (後) G を削除。
    let undo = vec![
        crate::database::BatchStatement {
            sql: "UPDATE tree_nodes SET parent_id = NULL, sort_order = 'a0', updated_at = datetime('now') WHERE id = ?".into(),
            params: vec![p("sc-keep")],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "DELETE FROM tree_nodes WHERE id = ?".into(),
            params: vec![p("g-new")],
            method: "run".into(),
        },
    ];
    db.execute_batch_tx(&undo).expect("cascade-safe undo");

    let keep = db
        .execute(
            "SELECT parent_id FROM tree_nodes WHERE id = 'sc-keep'",
            &[],
            "all",
        )
        .expect("query keep");
    assert_eq!(
        keep.len(),
        1,
        "existing scene must survive the cascade-safe undo"
    );
    assert_eq!(keep[0]["parent_id"], Value::Null, "scene restored to root");
    let gone = db
        .execute("SELECT id FROM tree_nodes WHERE id = 'g-new'", &[], "all")
        .expect("query g");
    assert_eq!(gone.len(), 0, "created folder removed");
}

/// 負のコントロール: undo を「(先)フォルダ削除」の順でやると ON DELETE CASCADE で
/// 既存シーンが巻き添え削除されることを実 SQLite で示し、restore-先順序が必須で
/// あることを裏付ける(applyPlan.ts が踏襲してはならない順序)。
#[test]
fn test_ai_tree_naive_undo_order_loses_existing_scene() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, 'default-project', NULL, 'scene', 'Keep', 'a0', datetime('now'), datetime('now'))",
        &[p("sc-keep")],
        "run",
    ).expect("insert scene");
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, 'default-project', NULL, 'folder', 'G', 'a1', datetime('now'), datetime('now'))",
        &[p("g-new")],
        "run",
    ).expect("insert folder");
    db.execute(
        "UPDATE tree_nodes SET parent_id = ? WHERE id = ?",
        &[p("g-new"), p("sc-keep")],
        "run",
    )
    .expect("move scene into folder");

    // 素朴な (誤った) undo 順: フォルダを先に削除 → cascade で sc-keep も消える。
    let naive = vec![
        crate::database::BatchStatement {
            sql: "DELETE FROM tree_nodes WHERE id = ?".into(),
            params: vec![p("g-new")],
            method: "run".into(),
        },
        crate::database::BatchStatement {
            sql: "UPDATE tree_nodes SET parent_id = NULL WHERE id = ?".into(),
            params: vec![p("sc-keep")],
            method: "run".into(),
        },
    ];
    db.execute_batch_tx(&naive).expect("naive undo runs");

    let keep = db
        .execute("SELECT id FROM tree_nodes WHERE id = 'sc-keep'", &[], "all")
        .expect("query");
    assert_eq!(
        keep.len(),
        0,
        "delete-first order cascade-deletes the existing scene — hence restore-first ordering is mandatory"
    );
}

/// Simulates an existing DB that was migrated by an older binary: the buggy
/// `delete_cv_on_*_delete` triggers are already installed. The next
/// `migrate()` call must drop them and reinstall the snapshot-aware version
/// so the user-visible bug stops reproducing.
#[test]
fn test_migrate_replaces_legacy_cv_triggers() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    // Re-introduce the legacy (buggy) triggers, overwriting the fixed ones.
    db.execute(
        "DROP TRIGGER IF EXISTS delete_cv_on_tree_node_delete",
        &[],
        "run",
    )
    .expect("drop");
    db.execute(
        "DROP TRIGGER IF EXISTS delete_cv_on_codex_entry_delete",
        &[],
        "run",
    )
    .expect("drop");
    db.execute(
        "DROP TRIGGER IF EXISTS delete_cv_on_snippet_delete",
        &[],
        "run",
    )
    .expect("drop");
    db.execute(
        "CREATE TRIGGER delete_cv_on_tree_node_delete AFTER DELETE ON tree_nodes BEGIN \
         DELETE FROM content_versions WHERE entity_type IN ('scene','note') AND entity_id = old.id; END",
        &[],
        "run",
    )
    .expect("legacy trigger");

    // Re-run migrate(); the helper should replace the legacy trigger.
    db.migrate().expect("re-migrate");

    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, 'default-project', 'scene', 'S', 'a0', datetime('now'), datetime('now'))",
        &[p("legacy-scene")],
        "run",
    ).expect("insert scene");
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'scene', ?, '{}', 1, 'auto', datetime('now'))",
        &[p("legacy-v"), p("legacy-scene")],
        "run",
    ).expect("insert version");
    db.execute(
        "INSERT INTO project_snapshots (id, project_id, name, created_at) VALUES (?, 'default-project', 'legacy snap', datetime('now'))",
        &[p("legacy-snap")],
        "run",
    ).expect("insert snapshot");
    db.execute(
        "INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES (?, ?)",
        &[p("legacy-snap"), p("legacy-v")],
        "run",
    )
    .expect("insert entry");

    db.execute(
        "DELETE FROM tree_nodes WHERE id = ?",
        &[p("legacy-scene")],
        "run",
    )
    .expect("post-migration delete must succeed");
}

/// Codex entries and snippets share the same trigger family; verify the
/// snapshot protection covers them too.
#[test]
fn test_delete_codex_entry_and_snippet_preserve_snapshot_versions() {
    let db = test_db();
    let p = |s: &str| Value::String(s.into());

    // Codex entry with a snapshot-protected version
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, 'default-project', 'character', 'X', datetime('now'), datetime('now'))",
        &[p("cx-1")],
        "run",
    ).expect("insert codex");
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'codex_entry', ?, '{}', 1, 'auto', datetime('now'))",
        &[p("cx-v1"), p("cx-1")],
        "run",
    ).expect("insert codex version");
    db.execute(
        "INSERT INTO project_snapshots (id, project_id, name, created_at) VALUES (?, 'default-project', ?, datetime('now'))",
        &[p("snap-cx"), p("codex snap")],
        "run",
    ).expect("insert snapshot");
    db.execute(
        "INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES (?, ?)",
        &[p("snap-cx"), p("cx-v1")],
        "run",
    )
    .expect("insert entry");
    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[p("cx-1")],
        "run",
    )
    .expect("delete codex entry");

    // Snippet with a snapshot-protected version
    db.execute(
        "INSERT INTO snippets (id, project_id, title, created_at, updated_at) VALUES (?, 'default-project', 'sn', datetime('now'), datetime('now'))",
        &[p("sn-1")],
        "run",
    ).expect("insert snippet");
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number, snapshot_type, created_at) VALUES (?, 'snippet', ?, '{}', 1, 'auto', datetime('now'))",
        &[p("sn-v1"), p("sn-1")],
        "run",
    ).expect("insert snippet version");
    db.execute(
        "INSERT INTO project_snapshots (id, project_id, name, created_at) VALUES (?, 'default-project', ?, datetime('now'))",
        &[p("snap-sn"), p("snippet snap")],
        "run",
    ).expect("insert snapshot");
    db.execute(
        "INSERT INTO project_snapshot_entries (snapshot_id, version_id) VALUES (?, ?)",
        &[p("snap-sn"), p("sn-v1")],
        "run",
    )
    .expect("insert entry");
    db.execute("DELETE FROM snippets WHERE id = ?", &[p("sn-1")], "run")
        .expect("delete snippet");

    let surviving = db
        .execute(
            "SELECT id FROM content_versions WHERE id IN ('cx-v1', 'sn-v1') ORDER BY id",
            &[],
            "all",
        )
        .expect("query");
    assert_eq!(
        surviving.len(),
        2,
        "both snapshot-protected versions survive"
    );
}

#[test]
fn test_integrity_check_clean_db() {
    let db = test_db();
    let report = db.integrity_check().expect("integrity check");
    assert_eq!(report["orphanedCodexSources"], Value::Number(0.into()));
    assert_eq!(report["orphanedSnippetSources"], Value::Number(0.into()));
    assert_eq!(report["orphanedSnippetScenes"], Value::Number(0.into()));
}

#[test]
fn test_integrity_check_detects_and_repairs_orphans() {
    let db = test_db();

    // source_chat_message_id now has a FK constraint; temporarily disable to simulate
    // corrupted/migrated data that integrity_check is designed to catch
    db.execute("PRAGMA foreign_keys=OFF", &[], "run")
        .expect("disable fk");
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("cx-orphan".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("孤立テスト".into()), Value::String("nonexistent".into())],
        "run",
    ).expect("insert orphan");
    db.execute("PRAGMA foreign_keys=ON", &[], "run")
        .expect("enable fk");

    let report = db.integrity_check().expect("check");
    assert_eq!(report["orphanedCodexSources"], Value::Number(1.into()));

    let repair = db.repair_integrity().expect("repair");
    assert_eq!(repair["codexSourcesFixed"], Value::Number(1.into()));

    let report2 = db.integrity_check().expect("check2");
    assert_eq!(report2["orphanedCodexSources"], Value::Number(0.into()));
}

#[test]
fn test_fts_optimize_succeeds() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, summary, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[
            Value::String("c-opt".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("テスト太郎".into()),
            Value::String("テスト用キャラクター".into()),
            Value::String("[]".into()),
        ],
        "run",
    ).expect("insert codex");

    db.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[
            Value::String("s-opt".into()),
            Value::String("default-project".into()),
            Value::String("テストスニペット".into()),
            Value::String("スニペット内容".into()),
            Value::String("[]".into()),
        ],
        "run",
    ).expect("insert snippet");

    db.fts_optimize().expect("fts_optimize should succeed");
}

#[test]
fn test_fts_rebuild_includes_en_tables() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'horses galloped');
             DELETE FROM tree_nodes_fts_en;",
        )
        .expect("seed + wipe");
    }
    db.fts_rebuild().expect("rebuild");
    db.fts_optimize().expect("optimize");
    let conn = db.conn.lock().expect("lock");
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"horse\""],
            |r| r.get(0),
        )
        .expect("match");
    assert_eq!(
        hits, 1,
        "fts_rebuild repopulated _en; fts_optimize did not error"
    );
}

#[test]
fn test_data_persists_across_reopen() {
    let dir = std::env::temp_dir().join("grimodex_test_persist_v2");
    std::fs::create_dir_all(&dir).ok();
    let db_path = dir.join("persist.db");
    std::fs::remove_file(&db_path).ok();

    {
        let db = Database::new(&db_path).expect("open db");
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
            &[
                Value::String("proj-persist".into()),
                Value::String("Persisted Novel".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
                Value::String("2025-01-01T00:00:00Z".into()),
            ],
            "run",
        )
        .expect("insert");
    }

    {
        let db = Database::new(&db_path).expect("reopen db");
        db.migrate().expect("migrate again");

        let rows = db
            .execute(
                "SELECT * FROM projects WHERE id = ?",
                &[Value::String("proj-persist".into())],
                "get",
            )
            .expect("select");
        assert_eq!(rows[0]["title"], Value::String("Persisted Novel".into()));
    }

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_wal_mode_enabled() {
    let dir = std::env::temp_dir().join("grimodex_test_wal_v2");
    std::fs::create_dir_all(&dir).ok();
    let db_path = dir.join("test.db");
    std::fs::remove_file(&db_path).ok();
    let db = Database::new(&db_path).expect("open db");
    let rows = db
        .execute("PRAGMA journal_mode", &[], "get")
        .expect("pragma");
    let mode = rows[0]
        .values()
        .next()
        .expect("value")
        .as_str()
        .expect("str")
        .to_lowercase();
    assert_eq!(mode, "wal");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn test_authorship_spans_crud() {
    let db = test_db();
    seed_default_chapter(&db);

    // Create a scene node first
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("sc-attr".into()), Value::String("default-project".into()), Value::String("default-chapter".into()), Value::String("scene".into()), Value::String("S1".into()), Value::String("a1".into())],
        "run",
    ).expect("insert scene");

    db.execute(
        "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source, model, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("attr-1".into()),
            Value::String("sc-attr".into()),
            Value::Number(0.into()),
            Value::Number(100.into()),
            Value::String("ai".into()),
            Value::String("claude-sonnet".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    ).expect("insert span");

    let rows = db
        .execute(
            "SELECT * FROM authorship_spans WHERE node_id = ?",
            &[Value::String("sc-attr".into())],
            "all",
        )
        .expect("select spans");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["source"], Value::String("ai".into()));
    assert_eq!(rows[0]["from_pos"], Value::Number(0.into()));
    assert_eq!(rows[0]["to_pos"], Value::Number(100.into()));
}

// --- BUG 1: codex_detail_definitions.type_slug FK ---

#[test]
fn test_codex_detail_definitions_crud() {
    let db = test_db();

    // Insert a definition for built-in type
    db.execute(
        "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("def-1".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("身長".into()),
            Value::String("text".into()),
            Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        ],
        "run",
    ).expect("insert definition");

    let rows = db
        .execute(
            "SELECT * FROM codex_detail_definitions WHERE id = ?",
            &[Value::String("def-1".into())],
            "get",
        )
        .expect("select");
    assert_eq!(rows[0]["name"], Value::String("身長".into()));
    assert_eq!(rows[0]["type_slug"], Value::String("character".into()));
}

#[test]
fn test_codex_detail_definitions_rejects_unknown_type_slug() {
    // 複合FK (project_id, type_slug) → codex_types(project_id, slug) により、
    // codex_types に存在しない type_slug への INSERT は DB 層で拒否される。
    let db = test_db();

    let result = db.execute(
        "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("def-custom".into()),
            Value::String("default-project".into()),
            Value::String("nonexistent-type".into()),
            Value::String("テスト".into()),
            Value::String("text".into()),
            Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        ],
        "run",
    );
    assert!(
        result.is_err(),
        "Composite FK should reject unknown type_slug"
    );
}

#[test]
fn test_codex_entries_rejects_unknown_type() {
    // 複合FK (project_id, type) → codex_types(project_id, slug) により、
    // codex_types に存在しない type への INSERT は DB 層で拒否される。
    let db = test_db();

    let result = db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ce-custom".into()),
            Value::String("default-project".into()),
            Value::String("nonexistent-type".into()),
            Value::String("テスト".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    );
    assert!(result.is_err(), "Composite FK should reject unknown type");
}

// --- BUG 3: field_type CHECK constraint ---

#[test]
fn test_codex_detail_definitions_rejects_invalid_field_type() {
    let db = test_db();

    let result = db.execute(
        "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("def-badft".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("テスト".into()),
            Value::String("invalid_type".into()),
            Value::Number(serde_json::Number::from_f64(0.0).unwrap()),
        ],
        "run",
    );
    assert!(
        result.is_err(),
        "Should reject definition with invalid field_type"
    );
}

// --- BUG 4: Built-in types seeded for new projects ---

#[test]
fn test_builtin_types_seeded_on_new_project() {
    let db = test_db();

    // Create a new project
    db.execute(
        "INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
        &[
            Value::String("new-project".into()),
            Value::String("新プロジェクト".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    )
    .expect("insert new project");

    // Check that built-in types were seeded
    let rows = db
        .execute(
            "SELECT * FROM codex_types WHERE project_id = ? ORDER BY sort_order",
            &[Value::String("new-project".into())],
            "all",
        )
        .expect("select types");

    assert_eq!(rows.len(), 4, "Should have 4 built-in types");
    assert_eq!(rows[0]["slug"], Value::String("character".into()));
    assert_eq!(rows[1]["slug"], Value::String("location".into()));
    assert_eq!(rows[2]["slug"], Value::String("item".into()));
    assert_eq!(rows[3]["slug"], Value::String("lore".into()));

    // All should be marked as built-in
    for row in &rows {
        assert_eq!(row["is_builtin"], Value::Number(1.into()));
    }
}

// --- Cascade delete tests for new tables ---

#[test]
fn test_cascade_delete_codex_entry_to_entry_tags() {
    let db = test_db();

    // Insert codex entry
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ce-cas".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("テスト".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    ).expect("insert entry");

    // Insert a tag
    db.execute(
        "INSERT INTO codex_tags (id, project_id, name) VALUES (?, ?, ?)",
        &[
            Value::String("tag-1".into()),
            Value::String("default-project".into()),
            Value::String("重要".into()),
        ],
        "run",
    )
    .expect("insert tag");

    // Link entry to tag
    db.execute(
        "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES (?, ?)",
        &[
            Value::String("ce-cas".into()),
            Value::String("tag-1".into()),
        ],
        "run",
    )
    .expect("insert entry_tag");

    // Delete the entry
    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[Value::String("ce-cas".into())],
        "run",
    )
    .expect("delete entry");

    // entry_tags should be cascade-deleted
    let rows = db
        .execute(
            "SELECT * FROM codex_entry_tags WHERE entry_id = ?",
            &[Value::String("ce-cas".into())],
            "all",
        )
        .expect("select entry_tags");
    assert_eq!(rows.len(), 0, "entry_tags should be cascade-deleted");
}

#[test]
fn test_cascade_delete_codex_entry_to_detail_values() {
    let db = test_db();

    // Insert codex entry
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ce-dv".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("テスト".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    ).expect("insert entry");

    // Insert a detail definition
    db.execute(
        "INSERT INTO codex_detail_definitions (id, project_id, type_slug, name, field_type) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("ddef-1".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("身長".into()),
            Value::String("text".into()),
        ],
        "run",
    ).expect("insert definition");

    // Insert a detail value
    db.execute(
        "INSERT INTO codex_detail_values (id, entry_id, definition_id, value) VALUES (?, ?, ?, ?)",
        &[
            Value::String("dval-1".into()),
            Value::String("ce-dv".into()),
            Value::String("ddef-1".into()),
            Value::String("170cm".into()),
        ],
        "run",
    )
    .expect("insert detail value");

    // Delete the entry
    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[Value::String("ce-dv".into())],
        "run",
    )
    .expect("delete entry");

    // detail_values should be cascade-deleted
    let rows = db
        .execute(
            "SELECT * FROM codex_detail_values WHERE entry_id = ?",
            &[Value::String("ce-dv".into())],
            "all",
        )
        .expect("select detail_values");
    assert_eq!(rows.len(), 0, "detail_values should be cascade-deleted");
}

// --- codex_types CRUD ---

#[test]
fn test_codex_types_crud() {
    let db = test_db();

    // Verify built-in types exist
    let rows = db
        .execute(
            "SELECT * FROM codex_types WHERE project_id = ? AND is_builtin = 1 ORDER BY sort_order",
            &[Value::String("default-project".into())],
            "all",
        )
        .expect("select built-in types");
    assert_eq!(rows.len(), 4);

    // Insert user-defined type
    db.execute(
        "INSERT INTO codex_types (id, project_id, slug, label, color, is_builtin, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("custom-org".into()),
            Value::String("default-project".into()),
            Value::String("organization".into()),
            Value::String("組織".into()),
            Value::String("#FF0000".into()),
            Value::Number(0.into()),
            Value::Number(serde_json::Number::from_f64(4.0).unwrap()),
        ],
        "run",
    ).expect("insert custom type");

    // Verify total count
    let rows = db
        .execute(
            "SELECT * FROM codex_types WHERE project_id = ?",
            &[Value::String("default-project".into())],
            "all",
        )
        .expect("select all types");
    assert_eq!(rows.len(), 5);

    // Create codex entry with custom type
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ce-org".into()),
            Value::String("default-project".into()),
            Value::String("organization".into()),
            Value::String("騎士団".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    ).expect("entry with custom type should succeed");
}

// --- codex_tags CRUD ---

#[test]
fn test_codex_tags_crud() {
    let db = test_db();

    db.execute(
        "INSERT INTO codex_tags (id, project_id, name, color) VALUES (?, ?, ?, ?)",
        &[
            Value::String("tag-crud".into()),
            Value::String("default-project".into()),
            Value::String("重要".into()),
            Value::String("#FF0000".into()),
        ],
        "run",
    )
    .expect("insert tag");

    let rows = db
        .execute(
            "SELECT * FROM codex_tags WHERE id = ?",
            &[Value::String("tag-crud".into())],
            "get",
        )
        .expect("select tag");
    assert_eq!(rows[0]["name"], Value::String("重要".into()));

    // Delete
    db.execute(
        "DELETE FROM codex_tags WHERE id = ?",
        &[Value::String("tag-crud".into())],
        "run",
    )
    .expect("delete tag");
    let rows = db
        .execute(
            "SELECT * FROM codex_tags WHERE id = ?",
            &[Value::String("tag-crud".into())],
            "all",
        )
        .expect("select after delete");
    assert_eq!(rows.len(), 0);
}

// --- context_mode CHECK constraint ---

#[test]
fn test_context_mode_rejects_invalid_value() {
    let db = test_db();

    let result = db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, context_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        &[
            Value::String("ce-badcm".into()),
            Value::String("default-project".into()),
            Value::String("character".into()),
            Value::String("テスト".into()),
            Value::String("invalid_mode".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
            Value::String("2025-01-01T00:00:00Z".into()),
        ],
        "run",
    );
    assert!(result.is_err(), "Should reject invalid context_mode");
}

// --- authorship_spans CHECK constraint ---

#[test]
fn test_authorship_spans_check_rejects_zero_owners() {
    let db = test_db();

    // All three owner columns NULL → CHECK violation
    let result = db.execute(
        "INSERT INTO authorship_spans (id, from_pos, to_pos, source) VALUES (?, ?, ?, ?)",
        &[
            Value::String("span-no-owner".into()),
            Value::Number(0.into()),
            Value::Number(10.into()),
            Value::String("human".into()),
        ],
        "run",
    );
    assert!(
        result.is_err(),
        "Should reject span with no owner (node_id/codex_entry_id/snippet_id all NULL)"
    );
}

#[test]
fn test_authorship_spans_check_rejects_two_owners() {
    let db = test_db();
    seed_default_chapter(&db);

    // Two owner columns set → CHECK violation
    let result = db.execute(
        "INSERT INTO authorship_spans (id, node_id, codex_entry_id, from_pos, to_pos, source) VALUES (?, ?, ?, ?, ?, ?)",
        &[
            Value::String("span-two-owners".into()),
            Value::String("default-chapter".into()),
            Value::String("some-codex".into()),
            Value::Number(0.into()),
            Value::Number(10.into()),
            Value::String("ai".into()),
        ],
        "run",
    );
    assert!(result.is_err(), "Should reject span with two owners");
}

#[test]
fn test_authorship_spans_check_accepts_single_owner() {
    let db = test_db();
    seed_default_chapter(&db);

    // node_id only → OK
    let r1 = db.execute(
        "INSERT INTO authorship_spans (id, node_id, from_pos, to_pos, source) VALUES (?, ?, ?, ?, ?)",
        &[
            Value::String("span-node".into()),
            Value::String("default-chapter".into()),
            Value::Number(0.into()),
            Value::Number(10.into()),
            Value::String("human".into()),
        ],
        "run",
    );
    assert!(r1.is_ok(), "Should accept span with node_id only");
}

// --- content_versions cascade delete via triggers ---

#[test]
fn test_content_versions_cascade_on_tree_node_delete() {
    let db = test_db();

    // Insert a scene node
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("scene-cv".into()), Value::String("default-project".into()), Value::String("scene".into()), Value::String("シーン".into()), Value::String("a1".into())],
        "run",
    ).expect("insert scene");

    // Insert a content_version referencing the scene
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number) VALUES (?, ?, ?, ?, ?)",
        &[Value::String("cv-1".into()), Value::String("scene".into()), Value::String("scene-cv".into()), Value::String("{}".into()), Value::Number(1.into())],
        "run",
    ).expect("insert version");

    // Delete the scene node
    db.execute(
        "DELETE FROM tree_nodes WHERE id = ?",
        &[Value::String("scene-cv".into())],
        "run",
    )
    .expect("delete scene");

    // content_versions should be cascade-deleted via trigger
    let rows = db
        .execute(
            "SELECT * FROM content_versions WHERE entity_id = ?",
            &[Value::String("scene-cv".into())],
            "all",
        )
        .expect("query");
    assert_eq!(
        rows.len(),
        0,
        "content_versions should be deleted when tree_node is deleted"
    );
}

#[test]
fn test_content_versions_cascade_on_codex_entry_delete() {
    let db = test_db();

    // Insert codex entry
    db.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
        &[Value::String("ce-cv".into()), Value::String("default-project".into()), Value::String("character".into()), Value::String("テスト".into())],
        "run",
    ).expect("insert entry");

    // Insert content_version
    db.execute(
        "INSERT INTO content_versions (id, entity_type, entity_id, content, version_number) VALUES (?, ?, ?, ?, ?)",
        &[Value::String("cv-2".into()), Value::String("codex_entry".into()), Value::String("ce-cv".into()), Value::String("{}".into()), Value::Number(1.into())],
        "run",
    ).expect("insert version");

    // Delete codex entry
    db.execute(
        "DELETE FROM codex_entries WHERE id = ?",
        &[Value::String("ce-cv".into())],
        "run",
    )
    .expect("delete entry");

    let rows = db
        .execute(
            "SELECT * FROM content_versions WHERE entity_id = ?",
            &[Value::String("ce-cv".into())],
            "all",
        )
        .expect("query");
    assert_eq!(
        rows.len(),
        0,
        "content_versions should be deleted when codex_entry is deleted"
    );
}

// --- PostEffects schema ---

fn seed_post_effect_scene(db: &Database) {
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) \
         VALUES ('pe-scene', 'default-project', 'scene', 'PE Scene', 'a0', datetime('now'), datetime('now'))",
        &[],
        "run",
    )
    .expect("seed pe-scene");
}

fn insert_pe_run(db: &Database, id: &str, scope_target: Option<&str>, status: &str) {
    let scope_val = scope_target
        .map(|s| Value::String(s.into()))
        .unwrap_or(Value::Null);
    db.execute(
        "INSERT INTO post_effect_runs \
            (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status, started_at) \
         VALUES (?, 'default-project', 'consistency', 'scene', ?, 'm', 'consistency_v1.0', ?, datetime('now'))",
        &[
            Value::String(id.into()),
            scope_val,
            Value::String(status.into()),
        ],
        "run",
    )
    .expect("insert pe run");
}

#[test]
fn test_post_effect_tables_exist() {
    let db = test_db();
    let expected = [
        "post_effect_runs",
        "post_effect_annotations",
        "post_effect_annotation_relations",
        "scene_lens_data",
        "post_effect_annotations_fts",
    ];
    for table in &expected {
        let rows = db
            .execute(
                "SELECT name FROM sqlite_master WHERE name=? AND type IN ('table','virtual table')",
                &[Value::String((*table).into())],
                "all",
            )
            .expect("query");
        assert_eq!(rows.len(), 1, "table '{}' should exist", table);
    }
}

#[test]
fn test_post_effect_runs_rejects_invalid_effect_type() {
    let db = test_db();
    let result = db.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version, status) \
         VALUES ('r1', 'default-project', 'bogus', 'scene', 'm', 'v', 'running')",
        &[],
        "run",
    );
    assert!(result.is_err(), "Should reject invalid effect_type");
}

#[test]
fn test_post_effect_runs_rejects_invalid_status() {
    let db = test_db();
    let result = db.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version, status) \
         VALUES ('r1', 'default-project', 'consistency', 'scene', 'm', 'v', 'spinning')",
        &[],
        "run",
    );
    assert!(result.is_err(), "Should reject invalid run status");
}

#[test]
fn test_post_effect_annotations_rejects_invalid_category() {
    let db = test_db();
    seed_post_effect_scene(&db);
    insert_pe_run(&db, "r1", Some("pe-scene"), "completed");
    let result = db.execute(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, scene_id, category, content) \
         VALUES ('a1', 'default-project', 'r1', 'pe-scene', 'invalid_cat', 'x')",
        &[],
        "run",
    );
    assert!(result.is_err(), "Should reject invalid category");
}

#[test]
fn test_post_effect_relations_rejects_invalid_direction() {
    let db = test_db();
    seed_post_effect_scene(&db);
    insert_pe_run(&db, "r1", Some("pe-scene"), "completed");
    db.execute(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, scene_id, category, content) \
         VALUES ('a1', 'default-project', 'r1', 'pe-scene', 'consistency_anchor', 'x'), \
                ('a2', 'default-project', 'r1', 'pe-scene', 'consistency_anchor', 'y')",
        &[],
        "run",
    )
    .expect("seed annotations");
    let result = db.execute(
        "INSERT INTO post_effect_annotation_relations (id, project_id, run_id, annotation_a_id, annotation_b_id, relation_type, direction) \
         VALUES ('rel1', 'default-project', 'r1', 'a1', 'a2', 'contradiction', 'sideways')",
        &[],
        "run",
    );
    assert!(result.is_err(), "Should reject invalid direction");
}

#[test]
fn test_post_effect_runs_running_scope_unique() {
    // 同じ (project, effect_type, scope) で running は 1 本まで。
    // running が終了すれば次の run を起動できる。
    let db = test_db();
    seed_post_effect_scene(&db);

    insert_pe_run(&db, "r1", Some("pe-scene"), "running");
    // 2 本目の running は UNIQUE 違反で弾かれる
    let dup = db.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, scope_target_id, model, prompt_version, status, started_at) \
         VALUES ('r2', 'default-project', 'consistency', 'scene', 'pe-scene', 'm', 'v', 'running', datetime('now'))",
        &[],
        "run",
    );
    assert!(
        dup.is_err(),
        "Second running run on same scope should be rejected"
    );

    // 別 scope なら通る
    db.execute(
        "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order, created_at, updated_at) \
         VALUES ('pe-scene-2', 'default-project', 'scene', 'PE Scene 2', 'a1', datetime('now'), datetime('now'))",
        &[],
        "run",
    )
    .expect("seed second scene");
    insert_pe_run(&db, "r3", Some("pe-scene-2"), "running");

    // r1 を completed に落とせば、同じ scope で次の running を起動できる
    db.execute(
        "UPDATE post_effect_runs SET status='completed', completed_at=datetime('now') WHERE id='r1'",
        &[],
        "run",
    )
    .expect("complete r1");
    insert_pe_run(&db, "r4", Some("pe-scene"), "running");
}

#[test]
fn test_post_effect_runs_running_scope_unique_for_project_wide() {
    // scope_target_id IS NULL (project-wide) でも単一性を保つ。
    // SQLite の NULL distinct 挙動を COALESCE で潰している箇所のテスト。
    let db = test_db();
    insert_pe_run(&db, "r1", None, "running");
    let dup = db.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version, status, started_at) \
         VALUES ('r2', 'default-project', 'consistency', 'scene', 'm', 'v', 'running', datetime('now'))",
        &[],
        "run",
    );
    assert!(
        dup.is_err(),
        "Two project-wide running runs (scope_target_id NULL) should be rejected"
    );
}

#[test]
fn test_post_effect_annotations_fts_sync_on_insert() {
    let db = test_db();
    seed_post_effect_scene(&db);
    insert_pe_run(&db, "r1", Some("pe-scene"), "completed");
    db.execute(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, scene_id, category, content) \
         VALUES ('a1', 'default-project', 'r1', 'pe-scene', 'review', '主人公の動機が薄い')",
        &[],
        "run",
    )
    .expect("insert annotation");

    let rows = db
        .execute(
            "SELECT content FROM post_effect_annotations_fts WHERE post_effect_annotations_fts MATCH ?",
            &[Value::String("主人公".into())],
            "all",
        )
        .expect("fts query");
    assert_eq!(
        rows.len(),
        1,
        "FTS should index inserted annotation content"
    );
}

#[test]
fn test_post_effect_crash_recovery_running_to_failed() {
    // プロセス強制終了で running のまま残った run は migrate() で failed に落ちる。
    let db = test_db();
    seed_post_effect_scene(&db);
    insert_pe_run(&db, "r1", Some("pe-scene"), "running");

    db.migrate().expect("re-migrate");

    let rows = db
        .execute(
            "SELECT status, error_message FROM post_effect_runs WHERE id = ?",
            &[Value::String("r1".into())],
            "all",
        )
        .expect("query");
    assert_eq!(rows[0]["status"], Value::String("failed".into()));
    assert_eq!(
        rows[0]["error_message"],
        Value::String("Process terminated unexpectedly".into())
    );
}

#[test]
fn test_migrate_codex_relations_source_map_edge_id_preserves_deleted_edge_ref() {
    let db = test_db();
    let conn = db.conn.lock().expect("lock");

    conn.execute_batch(
        "DROP TABLE IF EXISTS codex_relations;
         CREATE TABLE codex_relations (
            id                  TEXT PRIMARY KEY,
            project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
            to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
            relation_type       TEXT NOT NULL DEFAULT 'custom',
            label               TEXT,
            depth_hint          INTEGER,
            source_map_edge_id  TEXT REFERENCES map_edges(id) ON DELETE SET NULL,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
         );",
    )
    .expect("legacy codex_relations");

    conn.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, created_at, updated_at)
         VALUES ('cx-a', 'default-project', 'character', 'A', datetime('now'), datetime('now')),
                ('cx-b', 'default-project', 'character', 'B', datetime('now'), datetime('now'))",
        [],
    )
    .expect("codex");
    conn.execute(
        "INSERT INTO map_boards (id, project_id, title, created_at, updated_at)
         VALUES ('board-1', 'default-project', 'Main', datetime('now'), datetime('now'))",
        [],
    )
    .expect("board");
    conn.execute(
        "INSERT INTO map_node_positions
            (id, board_id, node_ref_type, codex_entry_id, x, y, pinned, z_index, created_at, updated_at)
         VALUES ('pos-a', 'board-1', 'codex', 'cx-a', 0, 0, 0, 0, datetime('now'), datetime('now')),
                ('pos-b', 'board-1', 'codex', 'cx-b', 100, 0, 0, 0, datetime('now'), datetime('now'))",
        [],
    )
    .expect("positions");
    conn.execute(
        "INSERT INTO map_edges (id, board_id, from_position_id, to_position_id, style, color, direction, created_at, updated_at)
         VALUES ('edge-1', 'board-1', 'pos-a', 'pos-b', 'solid', '#555555', 'none', datetime('now'), datetime('now'))",
        [],
    )
    .expect("edge");
    conn.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, source_map_edge_id, created_at, updated_at)
         VALUES ('rel-1', 'default-project', 'cx-a', 'cx-b', 'custom', 'edge-1', datetime('now'), datetime('now'))",
        [],
    )
    .expect("relation");

    Database::migrate_codex_relations_source_map_edge_id(&conn).expect("migrate");

    conn.execute("DELETE FROM map_edges WHERE id = 'edge-1'", [])
        .expect("delete edge");

    let source_edge: Option<String> = conn
        .query_row(
            "SELECT source_map_edge_id FROM codex_relations WHERE id = 'rel-1'",
            [],
            |row| row.get(0),
        )
        .expect("query");
    assert_eq!(source_edge.as_deref(), Some("edge-1"));

    let fk_cols: Vec<String> = conn
        .prepare("PRAGMA foreign_key_list(codex_relations)")
        .expect("pragma")
        .query_map([], |row| row.get::<_, String>("from"))
        .expect("map")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert!(
        !fk_cols.iter().any(|c| c == "source_map_edge_id"),
        "source_map_edge_id should no longer have FK"
    );
}

#[test]
fn test_migrate_chat_session_pinned_add_sticky_idempotent() {
    let db = test_db();
    let conn = db.conn.lock().expect("lock");
    Database::migrate_chat_session_pinned_add_sticky(&conn).expect("idempotent sticky migrate");
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(chat_session_pinned_codex)")
        .expect("pragma")
        .query_map([], |row| row.get::<_, String>("name"))
        .expect("map")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert!(cols.iter().any(|c| c == "sticky_id"));
}

/// Capture (column name, declared type) tuples for stable schema comparison.
fn table_column_signature(conn: &rusqlite::Connection, table: &str) -> Vec<(String, String)> {
    conn.prepare(&format!("PRAGMA table_info({})", table))
        .expect("pragma table_info")
        .query_map([], |row| {
            Ok((row.get::<_, String>("name")?, row.get::<_, String>("type")?))
        })
        .expect("map")
        .collect::<Result<_, _>>()
        .expect("collect")
}

fn fk_columns(conn: &rusqlite::Connection, table: &str) -> Vec<String> {
    let mut cols: Vec<String> = conn
        .prepare(&format!("PRAGMA foreign_key_list({})", table))
        .expect("pragma fk_list")
        .query_map([], |row| row.get::<_, String>("from"))
        .expect("map")
        .collect::<Result<_, _>>()
        .expect("collect");
    cols.sort();
    cols
}

/// New DB (fresh migrate) and a DB whose legacy table is upgraded via the
/// codex_relations FK-drop migration must end up with the same schema.
/// Catches drift between the initial CREATE TABLE and the upgrade path.
#[test]
fn test_migrate_codex_relations_schema_matches_new_db() {
    let fresh = test_db();
    let fresh_conn = fresh.conn.lock().expect("lock");
    let fresh_cols = table_column_signature(&fresh_conn, "codex_relations");
    let fresh_fks = fk_columns(&fresh_conn, "codex_relations");

    let legacy = test_db();
    let legacy_conn = legacy.conn.lock().expect("lock");
    legacy_conn
        .execute_batch(
            "DROP TABLE IF EXISTS codex_relations;
             CREATE TABLE codex_relations (
                id                  TEXT PRIMARY KEY,
                project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
                relation_type       TEXT NOT NULL DEFAULT 'custom',
                label               TEXT,
                depth_hint          INTEGER,
                source_map_edge_id  TEXT REFERENCES map_edges(id) ON DELETE SET NULL,
                created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )
        .expect("legacy schema");
    Database::migrate_codex_relations_source_map_edge_id(&legacy_conn).expect("upgrade");
    let upgraded_cols = table_column_signature(&legacy_conn, "codex_relations");
    let upgraded_fks = fk_columns(&legacy_conn, "codex_relations");

    assert_eq!(fresh_cols, upgraded_cols, "column signature must match");
    assert_eq!(fresh_fks, upgraded_fks, "FK columns must match");
    assert!(
        !fresh_fks.iter().any(|c| c == "source_map_edge_id"),
        "new DB must also have no FK on source_map_edge_id"
    );
}

/// Same drift check for chat_session_pinned_codex: rebuilt legacy table
/// must have the same columns and CHECK semantics as a freshly created one.
#[test]
fn test_migrate_chat_session_pinned_schema_matches_new_db() {
    let fresh = test_db();
    let fresh_conn = fresh.conn.lock().expect("lock");
    let fresh_cols = table_column_signature(&fresh_conn, "chat_session_pinned_codex");
    assert!(
        fresh_cols.iter().any(|(n, _)| n == "sticky_id"),
        "fresh DB must have sticky_id"
    );

    let legacy = test_db();
    let legacy_conn = legacy.conn.lock().expect("lock");
    legacy_conn
        .execute_batch(
            "DROP TABLE IF EXISTS chat_session_pinned_codex;
             CREATE TABLE chat_session_pinned_codex (
                id              TEXT PRIMARY KEY,
                session_id      TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                with_children   INTEGER NOT NULL DEFAULT 0,
                pin_source      TEXT NOT NULL DEFAULT 'manual'
                                  CHECK(pin_source IN ('manual','chat_mention')),
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (
                    (CASE WHEN codex_entry_id IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id     IS NOT NULL THEN 1 ELSE 0 END) = 1
                )
             );",
        )
        .expect("legacy schema");
    Database::migrate_chat_session_pinned_add_sticky(&legacy_conn).expect("upgrade");

    let upgraded_cols = table_column_signature(&legacy_conn, "chat_session_pinned_codex");
    assert_eq!(
        fresh_cols, upgraded_cols,
        "column signature must match between fresh DB and upgraded legacy DB"
    );
}

#[test]
fn test_migrate_authorship_spans_check_with_sticky_idempotent() {
    let db = test_db();
    let conn = db.conn.lock().expect("lock");
    Database::migrate_authorship_spans_check_with_sticky(&conn)
        .expect("idempotent authorship spans check migrate");
    Database::migrate_authorship_spans_check_with_sticky(&conn).expect("idempotent on second run");
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(authorship_spans)")
        .expect("pragma")
        .query_map([], |row| row.get::<_, String>("name"))
        .expect("map")
        .collect::<Result<_, _>>()
        .expect("collect");
    assert!(cols.iter().any(|c| c == "sticky_id"));
}

/// Legacy DBs added sticky_id via ALTER TABLE but the CHECK still required
/// exactly one of the original four FKs to be NOT NULL — sticky-only inserts
/// (e.g. Map AI branch) failed. Verify the rebuild allows sticky-only spans.
#[test]
fn test_migrate_authorship_spans_check_allows_sticky_only() {
    let legacy = test_db();
    let legacy_conn = legacy.conn.lock().expect("lock");
    // Recreate the pre-fix shape: column exists, but CHECK omits sticky_id.
    legacy_conn
        .execute_batch(
            "DROP TABLE IF EXISTS authorship_spans;
             CREATE TABLE authorship_spans (
                id              TEXT PRIMARY KEY,
                node_id         TEXT REFERENCES tree_nodes(id) ON DELETE CASCADE,
                codex_entry_id  TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id      TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                detail_value_id TEXT REFERENCES codex_detail_values(id) ON DELETE CASCADE,
                from_pos        INTEGER NOT NULL,
                to_pos          INTEGER NOT NULL,
                source          TEXT NOT NULL CHECK(source IN ('human','ai','unknown')),
                model           TEXT,
                timestamp       TEXT,
                chat_msg_id     TEXT,
                phase_id        TEXT REFERENCES codex_entry_phases(id) ON DELETE CASCADE,
                sticky_id       TEXT REFERENCES map_stickies(id) ON DELETE CASCADE,
                CHECK (
                    (CASE WHEN node_id         IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN codex_entry_id  IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN snippet_id      IS NOT NULL THEN 1 ELSE 0 END +
                     CASE WHEN detail_value_id IS NOT NULL THEN 1 ELSE 0 END) = 1
                ),
                CHECK (phase_id IS NULL OR codex_entry_id IS NOT NULL)
             );",
        )
        .expect("legacy schema");

    // Seed a board + sticky so the FK target exists.
    legacy_conn
        .execute_batch(
            "INSERT INTO projects (id, title) VALUES ('p1', 'P');
             INSERT INTO map_boards (id, project_id, title, mode, created_at, updated_at)
                VALUES ('b1', 'p1', 'B', 'free', datetime('now'), datetime('now'));
             INSERT INTO map_stickies
                (id, board_id, body, palette_id, color_slot, created_at, updated_at)
                VALUES ('s1', 'b1', '{}', 'default', 0,
                        datetime('now'), datetime('now'));",
        )
        .expect("seed");

    // Sticky-only insert must fail against the legacy CHECK.
    let legacy_err = legacy_conn.execute(
        "INSERT INTO authorship_spans
            (id, sticky_id, from_pos, to_pos, source, timestamp)
         VALUES ('a1', 's1', 0, 10, 'ai', datetime('now'))",
        [],
    );
    assert!(
        legacy_err.is_err(),
        "legacy CHECK must reject sticky-only span"
    );

    Database::migrate_authorship_spans_check_with_sticky(&legacy_conn).expect("upgrade");

    // After migration, the same insert must succeed.
    legacy_conn
        .execute(
            "INSERT INTO authorship_spans
                (id, sticky_id, from_pos, to_pos, source, timestamp)
             VALUES ('a1', 's1', 0, 10, 'ai', datetime('now'))",
            [],
        )
        .expect("sticky-only span insert must succeed after migration");

    // Exclusivity still holds: setting two owners must fail.
    let dup_err = legacy_conn.execute(
        "INSERT INTO authorship_spans
            (id, sticky_id, node_id, from_pos, to_pos, source)
         VALUES ('a2', 's1', 'whatever', 0, 10, 'ai')",
        [],
    );
    assert!(dup_err.is_err(), "two owners must still fail CHECK");
}

/// Plan B: legacy map_stickies (no ai_derived column) must gain ai_derived,
/// and existing branch-derived stickies (ai_branch_id IS NOT NULL) must be
/// backfilled to 1 while plain stickies stay 0.
#[test]
fn test_migrate_map_stickies_ai_derived_backfill() {
    let db = test_db();
    {
        let conn = db.conn.lock().expect("lock");
        conn.pragma_update(None, "foreign_keys", false)
            .expect("disable fk for legacy setup");
        conn.execute_batch(
            "DROP TABLE IF EXISTS map_stickies;
             CREATE TABLE map_stickies (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL,
                title TEXT,
                body TEXT NOT NULL DEFAULT '{}',
                preview_text TEXT,
                palette_id TEXT NOT NULL DEFAULT 'post-it-playful',
                color_slot INTEGER NOT NULL DEFAULT 0,
                ai_branch_id TEXT,
                source_chat_message_id TEXT
             );
             INSERT INTO map_stickies (id, board_id, ai_branch_id)
                VALUES ('s-branch', 'b1', 'branch-1');
             INSERT INTO map_stickies (id, board_id, ai_branch_id)
                VALUES ('s-plain', 'b1', NULL);",
        )
        .expect("create legacy map_stickies with data");
    }

    db.migrate().expect("migrate");

    let conn = db.conn.lock().expect("lock");
    let cols: Vec<String> = conn
        .prepare("PRAGMA table_info(map_stickies)")
        .expect("pragma")
        .query_map([], |row| row.get::<_, String>(1))
        .expect("map")
        .filter_map(|r| r.ok())
        .collect();
    assert!(
        cols.contains(&"ai_derived".to_string()),
        "ai_derived column must be added"
    );

    let branch_derived: i64 = conn
        .query_row(
            "SELECT ai_derived FROM map_stickies WHERE id = 's-branch'",
            [],
            |row| row.get(0),
        )
        .expect("query branch sticky");
    assert_eq!(branch_derived, 1, "branch-derived sticky backfilled to 1");

    let plain: i64 = conn
        .query_row(
            "SELECT ai_derived FROM map_stickies WHERE id = 's-plain'",
            [],
            |row| row.get(0),
        )
        .expect("query plain sticky");
    assert_eq!(plain, 0, "plain sticky stays 0");
}

/// Seed an in-memory DB to the legacy *timeline-migrated* state: the
/// post_effect_runs / post_effect_annotations CHECK 制約には typo / intent /
/// timeline までが入っているが impact_review はまだ無い。CHECK 文字列は
/// `'timeline_consistency')` / `'timeline_anchor')` で終わる形 ——
/// `migrate_post_effect_impact_review_categories` の `.replace` ターゲットと
/// 一致する必要がある。
fn open_post_timeline_post_effect_db() -> rusqlite::Connection {
    let conn = rusqlite::Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch(
        "CREATE TABLE post_effect_runs (
            id              TEXT PRIMARY KEY,
            project_id      TEXT NOT NULL,
            effect_type     TEXT NOT NULL
                              CHECK(effect_type IN ('review','pseudo_comment','meta_structure','consistency','intra_scene_consistency','typo_detection','intent_drift','timeline_consistency')),
            scope_type      TEXT NOT NULL,
            scope_target_id TEXT,
            model           TEXT NOT NULL,
            prompt_version  TEXT NOT NULL,
            input_hash      TEXT,
            status          TEXT NOT NULL DEFAULT 'running',
            summary         TEXT,
            error_message   TEXT,
            started_at      TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at    TEXT
        );
        CREATE TABLE post_effect_annotations (
            id             TEXT PRIMARY KEY,
            project_id     TEXT NOT NULL,
            run_id         TEXT,
            anchor_type    TEXT NOT NULL DEFAULT 'scene_range',
            scene_id       TEXT,
            range_start    INTEGER,
            range_end      INTEGER,
            text_snapshot  TEXT,
            category       TEXT NOT NULL
                              CHECK(category IN ('review','pseudo_comment','consistency_anchor','foreshadow_anchor','theme_anchor','typo_anchor','intent_anchor','timeline_anchor')),
            persona        TEXT,
            severity       TEXT,
            content        TEXT NOT NULL,
            author_role    TEXT NOT NULL DEFAULT 'ai',
            parent_id      TEXT,
            status         TEXT NOT NULL DEFAULT 'open',
            metadata       TEXT NOT NULL DEFAULT '{}',
            created_at     TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );",
    )
    .expect("seed legacy timeline-migrated post_effect tables");
    conn
}

#[test]
fn test_migrate_impact_review_categories_widens_legacy_timeline_check() {
    // Regression: the impact_review CHECK widening uses a fragile string .replace
    // on sqlite_master.sql and runs *after* the timeline migration. If the target
    // string drifts it silently no-ops, leaving upgraded DBs unable to INSERT
    // impact_review rows. Verify the legacy → migrated path really opens the gate.
    let conn = open_post_timeline_post_effect_db();

    // Before: impact_review / impact_review_anchor は拒否される。
    let run_before = conn.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
         VALUES ('r-ir', 'p1', 'impact_review', 'project', 'm', 'v')",
        [],
    );
    assert!(
        run_before.is_err(),
        "pre-impact_review schema should reject impact_review effect_type"
    );
    let ann_before = conn.execute(
        "INSERT INTO post_effect_annotations (id, project_id, category, content)
         VALUES ('a-ir', 'p1', 'impact_review_anchor', 'x')",
        [],
    );
    assert!(
        ann_before.is_err(),
        "pre-impact_review schema should reject impact_review_anchor category"
    );

    Database::migrate_post_effect_impact_review_categories(&conn).expect("migration ok");

    // After: impact_review run と impact_review_anchor annotation が両方 insert 可。
    conn.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
         VALUES ('r-ir', 'p1', 'impact_review', 'project', 'm', 'v')",
        [],
    )
    .expect("impact_review run accepted after migration");
    conn.execute(
        "INSERT INTO post_effect_annotations (id, project_id, run_id, category, content)
         VALUES ('a-ir', 'p1', 'r-ir', 'impact_review_anchor', 'x')",
        [],
    )
    .expect("impact_review_anchor annotation accepted after migration");

    // 既存の timeline カテゴリが消えていないこと (CHECK 文字列の累積)。
    conn.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
         VALUES ('r-tl', 'p1', 'timeline_consistency', 'project', 'm', 'v')",
        [],
    )
    .expect("timeline_consistency still accepted");

    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check");
    assert_eq!(
        integrity, "ok",
        "DB must remain consistent after CHECK widening"
    );

    // 冪等: 2回目以降は no-op で、insert 機能も保たれる。
    Database::migrate_post_effect_impact_review_categories(&conn).expect("second run no-op");
    Database::migrate_post_effect_impact_review_categories(&conn).expect("third run no-op");
    conn.execute(
        "INSERT INTO post_effect_runs (id, project_id, effect_type, scope_type, model, prompt_version)
         VALUES ('r-ir2', 'p1', 'impact_review', 'scene', 'm', 'v')",
        [],
    )
    .expect("impact_review still accepted after idempotent re-run");
    conn.execute(
        "INSERT INTO post_effect_annotations (id, project_id, category, content)
         VALUES ('a-ir2', 'p1', 'impact_review_anchor', 'x')",
        [],
    )
    .expect("impact_review_anchor still accepted after idempotent re-run");

    let integrity_again: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .expect("integrity_check after re-run");
    assert_eq!(integrity_again, "ok");
}

#[test]
fn test_language_switch_reroutes_en_index() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p', 'P', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p', 'scene', 'Ch1', 'she was studying hard');",
        )
        .expect("seed en");
    }
    // English now: search routes to _en and stems.
    assert_eq!(
        db.search_fts("p", "studies", "scenes", 10)
            .expect("en search")
            .len(),
        1
    );

    // Switch to Japanese, then rebuild _en (mirrors the updateProject hook).
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute("UPDATE projects SET language = 'ja' WHERE id = 'p'", [])
            .expect("switch to ja");
    }
    db.rebuild_en_fts().expect("rebuild after switch");
    {
        let conn = db.conn.lock().expect("lock");
        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
            .expect("count");
        assert_eq!(
            remaining, 0,
            "no en-project rows remain in _en after switch to ja"
        );
    }
    // Trigram still has the content, so the literal word is findable as ja.
    assert_eq!(
        db.search_fts("p", "studying", "scenes", 10)
            .expect("ja search")
            .len(),
        1
    );

    // Switch back to English and rebuild.
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute("UPDATE projects SET language = 'en' WHERE id = 'p'", [])
            .expect("switch to en");
    }
    db.rebuild_en_fts().expect("rebuild back to en");
    assert_eq!(
        db.search_fts("p", "studies", "scenes", 10)
            .expect("en search again")
            .len(),
        1
    );
}
