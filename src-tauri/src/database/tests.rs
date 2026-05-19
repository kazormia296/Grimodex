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
