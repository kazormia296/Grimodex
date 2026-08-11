#![allow(dead_code)]

use std::fs;
use std::path::{Path, PathBuf};

use grimodex_core::{
    workspace_schema::has_current_schema_checkpoint_invariants, LAST_PUBLIC_RELEASE_SCHEMA_VERSION,
    SCHEMA_VERSION,
};
use rusqlite::{config::DbConfig, params, Connection, OptionalExtension};

/// Physical DDL for the last public Release (v2.0.10 / Schema 2). SHA-matched
/// to the tagged seed; do not stamp with rolling PREVIOUS_COMPATIBLE_*.
const PREVIOUS_RELEASE_SCHEMA_SQL: &str = include_str!("../../../../../scripts/schema-seed-ja.sql");

pub const PROJECT_ID: &str = "gate-a2-project";
pub const FOLDER_ID: &str = "gate-a2-folder";
pub const SCENE_ID: &str = "gate-a2-scene";
pub const CODEX_ID: &str = "gate-a2-codex";
pub const EVENT_ID: &str = "gate-a2-event";
pub const WAL_ONLY_SETTING_KEY: &str = "gate-a2.wal-only";

pub fn temp_workspace(label: &str) -> PathBuf {
    let workspace =
        std::env::temp_dir().join(format!("grimodex-gate-a2-{label}-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&workspace).expect("create temporary workspace");
    workspace
}

pub fn seed_previous_release_workspace(workspace: &Path) -> PathBuf {
    fs::create_dir_all(workspace).expect("create workspace");
    let db_path = workspace.join("grimodex.db");
    {
        let conn = Connection::open(&db_path).expect("open release fixture db");
        conn.execute_batch(PREVIOUS_RELEASE_SCHEMA_SQL)
            .expect("create previous-release seed schema");
        create_previous_release_ai_audit_schema(&conn)
            .expect("create previous-release AI audit schema");
        seed_release_rows(&conn).expect("seed previous-release fixture rows");
        conn.pragma_update(None, "user_version", LAST_PUBLIC_RELEASE_SCHEMA_VERSION)
            .expect("stamp fixture marker as last public release");
        assert_previous_release_schema_on_connection(&conn);
    }
    grimodex_db::migration_supervisor::seal_sqlite_image(&db_path)
        .expect("seal base release fixture before dirty WAL write");
    commit_wal_only_setting(&db_path);
    assert!(
        db_path.with_extension("db-wal").exists(),
        "fixture must keep a committed WAL sidecar"
    );
    db_path
}

pub fn assert_release_fixture_rows(db_path: &Path) {
    let conn = Connection::open(db_path).expect("open db for fixture assertions");
    assert_eq!(
        user_version(&conn),
        SCHEMA_VERSION,
        "fixture should be migrated to the current marker"
    );
    assert_current_release_schema_on_connection(&conn);
    assert_release_rows_on_connection(&conn);
    let wal_value: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [WAL_ONLY_SETTING_KEY],
            |row| row.get(0),
        )
        .expect("WAL-only app_settings row must be visible after migration");
    assert_eq!(wal_value, "committed only in wal");
}

pub fn assert_previous_release_snapshot_rows(snapshot_path: &Path) {
    let conn = Connection::open(snapshot_path).expect("open migration snapshot");
    assert_eq!(
        user_version(&conn),
        LAST_PUBLIC_RELEASE_SCHEMA_VERSION,
        "snapshot must preserve the last public release marker"
    );
    assert_previous_release_schema_on_connection(&conn);
    assert_release_rows_on_connection(&conn);
    let wal_value: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [WAL_ONLY_SETTING_KEY],
            |row| row.get(0),
        )
        .expect("WAL-only row must be materialized into the snapshot");
    assert_eq!(wal_value, "committed only in wal");
}

pub fn latest_migration_snapshot(workspace: &Path) -> PathBuf {
    let mut snapshots = fs::read_dir(workspace.join("backups/migrations"))
        .expect("read migrations directory")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("db"))
        .collect::<Vec<_>>();
    snapshots.sort();
    snapshots
        .pop()
        .expect("migration snapshot should be retained")
}

pub fn live_user_version(workspace: &Path) -> i32 {
    let conn = Connection::open(workspace.join("grimodex.db")).expect("open live db");
    user_version(&conn)
}

pub fn assert_previous_release_fixture_shape(db_path: &Path) {
    let conn = Connection::open(db_path).expect("open pre-migration fixture");
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .expect("preserve dirty WAL while probing previous-release fixture");
    assert_previous_release_schema_on_connection(&conn);
}

fn create_previous_release_ai_audit_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ai_audit_events (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            scope_id            TEXT NOT NULL,
            project_id          TEXT REFERENCES projects(id) ON DELETE CASCADE,
            sequence            INTEGER NOT NULL,
            event_id            TEXT NOT NULL,
            execution_id        TEXT NOT NULL,
            operation_id        TEXT NOT NULL,
            parent_execution_id TEXT,
            path_id             TEXT NOT NULL,
            event_type          TEXT NOT NULL,
            timestamp           INTEGER NOT NULL,
            recorded_at         INTEGER NOT NULL,
            payload             TEXT NOT NULL,
            payload_sha256      TEXT NOT NULL,
            prev_hash           TEXT NOT NULL,
            hash                TEXT NOT NULL,
            CHECK (
                (scope_id = 'workspace' AND project_id IS NULL)
                OR
                (project_id IS NOT NULL AND scope_id = 'project:' || project_id)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_audit_scope_seq
            ON ai_audit_events(scope_id, sequence);
        CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_audit_scope_event
            ON ai_audit_events(scope_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_execution
            ON ai_audit_events(scope_id, execution_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_execution_event_type
            ON ai_audit_events(scope_id, execution_id, event_type);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_operation
            ON ai_audit_events(scope_id, operation_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_ai_audit_scope_timestamp
            ON ai_audit_events(scope_id, timestamp, sequence);",
    )?;
    Ok(())
}

fn assert_previous_release_schema_on_connection(conn: &Connection) {
    assert_eq!(
        user_version(conn),
        LAST_PUBLIC_RELEASE_SCHEMA_VERSION,
        "last public release fixture must use Schema {} (v2.0.10), not the rolling previous-compatible marker",
        LAST_PUBLIC_RELEASE_SCHEMA_VERSION
    );
    assert!(
        !table_exists(conn, "editor_stickies"),
        "v2.0.10 physical schema must not already include editor_stickies"
    );
    assert!(
        !table_exists(conn, "narrative_runtime_policy"),
        "v2.0.10 physical schema must not already include narrative_runtime_policy"
    );
    assert!(
        !has_current_schema_checkpoint_invariants(conn)
            .expect("probe current schema checkpoint invariants"),
        "last public release physical schema must not already satisfy current invariants"
    );
}

fn assert_current_release_schema_on_connection(conn: &Connection) {
    assert_eq!(
        user_version(conn),
        SCHEMA_VERSION,
        "migrated fixture must stamp the current schema marker"
    );
    assert!(
        table_exists(conn, "editor_stickies"),
        "migrated fixture should include the v3 editor_stickies table"
    );
    assert!(
        table_exists(conn, "narrative_runtime_policy"),
        "migrated fixture should include the Schema 4 narrative_runtime_policy singleton"
    );
    assert!(
        has_current_schema_checkpoint_invariants(conn)
            .expect("probe current schema checkpoint invariants"),
        "migrated fixture should satisfy current schema checkpoint invariants"
    );
}

fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
        )",
        [table],
        |row| row.get(0),
    )
    .expect("probe table existence")
}

fn seed_release_rows(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    conn.execute(
        "INSERT INTO projects (id, title, language, phase_resolution_mode)
         VALUES (?1, 'Gate A2 Release Fixture', 'ja', 'auto')",
        [PROJECT_ID],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, is_builtin)
         VALUES ('gate-a2-type-character', ?1, 'character', 'Character', 1)",
        [PROJECT_ID],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, char_count, status)
         VALUES (?1, ?2, NULL, 'folder', '第一部', 'a0', ?3, 0, 'outline')",
        params![FOLDER_ID, PROJECT_ID, "{}"],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, char_count, status)
         VALUES (?1, ?2, ?3, 'scene', '霧の港', 'a1', ?4, 18, 'draft')",
        params![
            SCENE_ID,
            PROJECT_ID,
            FOLDER_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Gate A2 scene body 初稿"}]}]}"#
        ],
    )?;
    conn.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, tags_cache)
         VALUES (?1, ?2, 'character', '灯真', 'Toma', 'Gate A2 codex summary', ?3, 'fixture')",
        params![
            CODEX_ID,
            PROJECT_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Codex body survives Gate A2"}]}]}"#
        ],
    )?;
    conn.execute(
        "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, start_time, start_granularity, precision, kind)
         VALUES (?1, ?2, '港での邂逅', 'Gate A2 chronicle event', 'a0', ?3, 42, 'day', 'exact', 'generic')",
        params![EVENT_ID, PROJECT_ID, CODEX_ID],
    )?;
    conn.execute(
        "INSERT INTO chat_sessions (id, project_id, node_id, title)
         VALUES ('gate-a2-session', ?1, ?2, 'Gate A2 chat')",
        params![PROJECT_ID, SCENE_ID],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('gate-a2-user-message', 'gate-a2-session', 'user', '灯真の秘密を整理して', NULL, 12, NULL)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('gate-a2-assistant-message', 'gate-a2-session', 'assistant', 'Gate A2 AI answer for audit chain', 'anthropic/claude-sonnet-4.6', 12, 34)",
        [],
    )?;
    conn.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, content_source, scene_id, source_chat_message_id)
         VALUES ('gate-a2-snippet', ?1, '抽出メモ', ?2, 'fixture', 'ai', ?3, 'gate-a2-assistant-message')",
        params![
            PROJECT_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Gate A2 snippet"}]}]}"#,
            SCENE_ID
        ],
    )?;
    conn.execute(
        r#"INSERT INTO ai_audit_events
            (scope_id, project_id, sequence, event_id, execution_id, operation_id,
             parent_execution_id, path_id, event_type, timestamp, recorded_at,
             payload, payload_sha256, prev_hash, hash)
         VALUES
            (?1, ?2, 1, 'gate-a2-audit-1', 'gate-a2-exec', 'gate-a2-op',
             NULL, 'chat/gate-a2-session', 'request', 1000, 1001,
             '{"kind":"request"}', 'payload-sha-1', 'GENESIS', 'hash-1')"#,
        params![format!("project:{PROJECT_ID}"), PROJECT_ID],
    )?;
    conn.execute(
        r#"INSERT INTO ai_audit_events
            (scope_id, project_id, sequence, event_id, execution_id, operation_id,
             parent_execution_id, path_id, event_type, timestamp, recorded_at,
             payload, payload_sha256, prev_hash, hash)
         VALUES
            (?1, ?2, 2, 'gate-a2-audit-2', 'gate-a2-exec', 'gate-a2-op',
             'gate-a2-exec-parent', 'chat/gate-a2-session', 'response', 1002, 1003,
             '{"kind":"response"}', 'payload-sha-2', 'hash-1', 'hash-2')"#,
        params![format!("project:{PROJECT_ID}"), PROJECT_ID],
    )?;
    conn.execute(
        "INSERT INTO app_settings (key, value)
         VALUES ('gate-a2.release-fixture', 'seeded')",
        [],
    )?;
    Ok(())
}

fn commit_wal_only_setting(db_path: &Path) {
    let conn = Connection::open(db_path).expect("open fixture for dirty WAL");
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
        .expect("disable checkpoint on close for dirty WAL fixture");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("enable WAL");
    conn.pragma_update(None, "wal_autocheckpoint", 0)
        .expect("disable WAL autocheckpoint");
    conn.execute(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
        params![WAL_ONLY_SETTING_KEY, "committed only in wal"],
    )
    .expect("commit WAL-only setting");
}

fn assert_release_rows_on_connection(conn: &Connection) {
    let project_title: String = conn
        .query_row(
            "SELECT title FROM projects WHERE id = ?1",
            [PROJECT_ID],
            |row| row.get(0),
        )
        .expect("project row");
    assert_eq!(project_title, "Gate A2 Release Fixture");

    let folder_parent: Option<String> = conn
        .query_row(
            "SELECT parent_id FROM tree_nodes WHERE id = ?1 AND node_type = 'folder'",
            [FOLDER_ID],
            |row| row.get(0),
        )
        .expect("folder row");
    assert_eq!(folder_parent, None);

    let scene_body: String = conn
        .query_row(
            "SELECT content FROM tree_nodes WHERE id = ?1 AND parent_id = ?2",
            params![SCENE_ID, FOLDER_ID],
            |row| row.get(0),
        )
        .expect("scene body row");
    assert!(scene_body.contains("Gate A2 scene body"));

    let codex_summary: String = conn
        .query_row(
            "SELECT summary FROM codex_entries WHERE id = ?1",
            [CODEX_ID],
            |row| row.get(0),
        )
        .expect("codex row");
    assert_eq!(codex_summary, "Gate A2 codex summary");

    let event_note: String = conn
        .query_row("SELECT note FROM events WHERE id = ?1", [EVENT_ID], |row| {
            row.get(0)
        })
        .expect("chronicle event row");
    assert_eq!(event_note, "Gate A2 chronicle event");

    let codex_fts_row: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM codex_fts
              WHERE rowid = (SELECT rowid FROM codex_entries WHERE id = ?1)",
            [CODEX_ID],
            |row| row.get(0),
        )
        .expect("codex FTS row");
    assert_eq!(codex_fts_row, 1);

    let scene_fts_row: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tree_nodes_fts
              WHERE rowid = (SELECT rowid FROM tree_nodes WHERE id = ?1)",
            [SCENE_ID],
            |row| row.get(0),
        )
        .expect("scene FTS row");
    assert_eq!(scene_fts_row, 1);

    let audit_tip: Option<String> = conn
        .query_row(
            "SELECT hash FROM ai_audit_events
              WHERE scope_id = ?1 AND sequence = 2 AND prev_hash = 'hash-1'",
            [format!("project:{PROJECT_ID}")],
            |row| row.get(0),
        )
        .optional()
        .expect("audit chain query");
    assert_eq!(audit_tip.as_deref(), Some("hash-2"));

    let setting: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'gate-a2.release-fixture'",
            [],
            |row| row.get(0),
        )
        .expect("app_settings row");
    assert_eq!(setting, "seeded");
}

fn user_version(conn: &Connection) -> i32 {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .expect("read user_version")
}
