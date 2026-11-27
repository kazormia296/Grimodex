#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// project_id, surface, entity_kind, entity_id, op_kind, before_json,
/// after_json, base_version, result_version, change_event_uid, created_at.
type UndoJournalRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<String>,
    String,
);

/// The seeded undo row must stay inside the open-time 90-day undo retention
/// (`open.rs` maintenance → `lib.rs` pruning of `undo_journal.created_at <
/// datetime('now', '-90 days')`). A fixed calendar date would silently age out
/// and make the reopen paths look like they lose author data. Computed once per
/// test process so the seed and the post-migration check see the same value.
fn undo_journal_created_at() -> &'static str {
    static CREATED_AT: OnceLock<String> = OnceLock::new();
    CREATED_AT.get_or_init(|| {
        (chrono::Utc::now() - chrono::Duration::days(1))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string()
    })
}

use grimodex_core::{
    workspace_schema::has_current_schema_checkpoint_invariants, LAST_PUBLIC_RELEASE_SCHEMA_VERSION,
    SCHEMA_VERSION,
};
use rusqlite::{config::DbConfig, params, Connection, OptionalExtension};

/// The schema-seed-ja.sql subset of v2.0.10 (Schema 2); startup-created tables
/// are added separately below. Do not stamp with rolling PREVIOUS_COMPATIBLE_*.
const PREVIOUS_RELEASE_SCHEMA_SQL: &str = include_str!("../../../../../scripts/schema-seed-ja.sql");

pub const PROJECT_ID: &str = "gate-a2-project";
pub const SECOND_PROJECT_ID: &str = "default-project";
pub const SECOND_SCENE_ID: &str = "default-project-scene";
pub const FOLDER_ID: &str = "gate-a2-folder";
pub const SCENE_ID: &str = "gate-a2-scene";
pub const CODEX_ID: &str = "gate-a2-codex";
pub const EVENT_ID: &str = "gate-a2-event";
pub const WAL_ONLY_SETTING_KEY: &str = "gate-a2.wal-only";
pub const RELEASE_FIXTURE_SETTING_KEY: &str = "gate-a2.release-fixture";
pub const SECOND_RELEASE_FIXTURE_SETTING_KEY: &str = "default-project.release-fixture";
pub const LEGACY_PROJECT_IDS: [&str; 2] = [SECOND_PROJECT_ID, PROJECT_ID];

/// The release fixture owns this manifest. Acceptance tests must consume it
/// instead of maintaining a second, hand-copied list of seeded legacy tables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LegacySeedScope {
    ProjectIdentity,
    ProjectId,
    SceneEventIdentity,
    ChatSessionIdentity,
    FtsSource { source_table: &'static str },
    AuditProject,
    AppSettingKey,
}

impl LegacySeedScope {
    pub const fn label(self) -> &'static str {
        match self {
            Self::ProjectIdentity => "project-id",
            Self::ProjectId => "project row identity",
            Self::SceneEventIdentity => "scene_id/event_id seeded identity",
            Self::ChatSessionIdentity => "chat session seeded identity",
            Self::FtsSource { source_table } => source_table,
            Self::AuditProject => "project_id plus scope_id=project:<project_id>",
            Self::AppSettingKey => "explicit release-fixture setting keys",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacySeedTable {
    pub table: &'static str,
    pub order_by: &'static str,
    pub identity_columns: &'static [&'static str],
    pub scope: LegacySeedScope,
}

/// Every user row seeded by `seed_release_rows` is represented by one of these
/// descriptors. The identity columns are the immutable seeded-row boundary;
/// runtime rows added later must not become migration-compatibility failures.
pub const LEGACY_SEED_TABLES: &[LegacySeedTable] = &[
    LegacySeedTable {
        table: "projects",
        order_by: "id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectIdentity,
    },
    LegacySeedTable {
        table: "project_settings",
        order_by: "project_id, key",
        identity_columns: &["project_id", "key"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "map_boards",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "codex_types",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "tree_nodes",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "codex_entries",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "codex_relations",
        order_by: "id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "change_events",
        order_by: "id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "undo_journal",
        order_by: "id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "events",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "scene_events",
        order_by: "scene_id, event_id",
        identity_columns: &["scene_id", "event_id"],
        scope: LegacySeedScope::SceneEventIdentity,
    },
    LegacySeedTable {
        table: "chat_sessions",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "chat_messages",
        order_by: "session_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ChatSessionIdentity,
    },
    LegacySeedTable {
        table: "snippets",
        order_by: "project_id, id",
        identity_columns: &["id"],
        scope: LegacySeedScope::ProjectId,
    },
    LegacySeedTable {
        table: "codex_fts",
        order_by: "rowid",
        identity_columns: &["rowid"],
        scope: LegacySeedScope::FtsSource {
            source_table: "codex_entries",
        },
    },
    LegacySeedTable {
        table: "snippets_fts",
        order_by: "rowid",
        identity_columns: &["rowid"],
        scope: LegacySeedScope::FtsSource {
            source_table: "snippets",
        },
    },
    LegacySeedTable {
        table: "chat_messages_fts",
        order_by: "rowid",
        identity_columns: &["rowid"],
        scope: LegacySeedScope::FtsSource {
            source_table: "chat_messages",
        },
    },
    LegacySeedTable {
        table: "tree_nodes_fts",
        order_by: "rowid",
        identity_columns: &["rowid"],
        scope: LegacySeedScope::FtsSource {
            source_table: "tree_nodes",
        },
    },
    LegacySeedTable {
        table: "ai_audit_events",
        order_by: "scope_id, sequence, event_id",
        identity_columns: &["scope_id", "sequence"],
        scope: LegacySeedScope::AuditProject,
    },
    LegacySeedTable {
        table: "app_settings",
        order_by: "key",
        identity_columns: &["key"],
        scope: LegacySeedScope::AppSettingKey,
    },
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LegacyFtsTokenCheck {
    pub surface_table: &'static str,
    pub source_table: &'static str,
    pub source_id: &'static str,
    pub token: &'static str,
}

/// One unique search token per seeded source row and FTS surface. These are
/// deliberately boring ASCII words so the legacy trigram tokenizer and the
/// current index have the same deterministic MATCH contract.
pub const LEGACY_FTS_TOKEN_CHECKS: &[LegacyFtsTokenCheck] = &[
    LegacyFtsTokenCheck {
        surface_table: "codex_fts",
        source_table: "codex_entries",
        source_id: CODEX_ID,
        token: "gatea2codexneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "codex_fts",
        source_table: "codex_entries",
        source_id: "gate-a2-related-codex",
        token: "gatea2relatedcodexneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "codex_fts",
        source_table: "codex_entries",
        source_id: "default-project-codex",
        token: "defaultprojectcodexneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "snippets_fts",
        source_table: "snippets",
        source_id: "gate-a2-snippet",
        token: "gatea2snippetneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "snippets_fts",
        source_table: "snippets",
        source_id: "default-project-snippet",
        token: "defaultprojectsnippetneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "chat_messages_fts",
        source_table: "chat_messages",
        source_id: "gate-a2-user-message",
        token: "gatea2chatuserneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "chat_messages_fts",
        source_table: "chat_messages",
        source_id: "gate-a2-assistant-message",
        token: "gatea2chatassistantneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "chat_messages_fts",
        source_table: "chat_messages",
        source_id: "default-project-user-message",
        token: "defaultprojectchatuserneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "chat_messages_fts",
        source_table: "chat_messages",
        source_id: "default-project-assistant-message",
        token: "defaultprojectchatassistantneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "tree_nodes_fts",
        source_table: "tree_nodes",
        source_id: FOLDER_ID,
        token: "gatea2folderneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "tree_nodes_fts",
        source_table: "tree_nodes",
        source_id: SCENE_ID,
        token: "gatea2sceneneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "tree_nodes_fts",
        source_table: "tree_nodes",
        source_id: "default-project-folder",
        token: "defaultprojectfolderneedle",
    },
    LegacyFtsTokenCheck {
        surface_table: "tree_nodes_fts",
        source_table: "tree_nodes",
        source_id: SECOND_SCENE_ID,
        token: "defaultprojectsceneneedle",
    },
];

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
        create_previous_release_startup_schema(&conn)
            .expect("create previous-release startup schema");
        create_previous_release_ai_audit_schema(&conn)
            .expect("create previous-release AI audit schema");
        let row_counts_before_seed = table_row_counts(&conn);
        seed_release_rows(&conn).expect("seed previous-release fixture rows");
        let row_counts_after_seed = table_row_counts(&conn);
        assert_seed_manifest_covers_row_deltas(&row_counts_before_seed, &row_counts_after_seed);
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

/// Startup DDL from v2.0.10 migrate.rs: codex_relations 1135-1154 and final
/// rebuilt shape 3001-3027; change_events 1495-1516, event_uid 1535, unique
/// index 1543-1544; undo_journal 2037-2052.
fn create_previous_release_startup_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE codex_relations (
            id                  TEXT PRIMARY KEY,
            project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            from_codex_id       TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
            to_codex_id         TEXT NOT NULL REFERENCES codex_entries(id) ON DELETE CASCADE,
            relation_type       TEXT NOT NULL DEFAULT 'custom',
            label               TEXT,
            depth_hint          INTEGER,
            source_map_edge_id  TEXT,
            created_at          TEXT NOT NULL,
            updated_at          TEXT NOT NULL
        );
        CREATE INDEX idx_codex_relations_project ON codex_relations(project_id);
        CREATE INDEX idx_codex_relations_from ON codex_relations(from_codex_id);
        CREATE INDEX idx_codex_relations_to ON codex_relations(to_codex_id);
        CREATE TABLE change_events (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            event_uid    TEXT,
            project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            scene_id     TEXT REFERENCES tree_nodes(id) ON DELETE SET NULL,
            domain       TEXT NOT NULL,
            op_type      TEXT NOT NULL,
            entity_type  TEXT,
            entity_id    TEXT,
            payload      TEXT NOT NULL,
            session_id   TEXT NOT NULL,
            sequence     INTEGER NOT NULL,
            timestamp    INTEGER NOT NULL,
            prev_hash    TEXT NOT NULL,
            hash         TEXT NOT NULL
        );
        CREATE INDEX idx_change_events_project_ts ON change_events(project_id, timestamp);
        CREATE INDEX idx_change_events_scene_ts ON change_events(scene_id, timestamp);
        CREATE UNIQUE INDEX uq_change_events_project_seq ON change_events(project_id, sequence);
        CREATE UNIQUE INDEX uq_change_events_project_uid ON change_events(project_id, event_uid);
        CREATE TABLE undo_journal (
            id                  TEXT PRIMARY KEY,
            project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            surface             TEXT NOT NULL,
            entity_kind         TEXT NOT NULL,
            entity_id           TEXT NOT NULL,
            op_kind             TEXT NOT NULL,
            before_json         TEXT,
            after_json          TEXT,
            base_version        INTEGER NOT NULL,
            result_version      INTEGER NOT NULL,
            change_event_uid    TEXT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_undo_journal_project_entity
            ON undo_journal(project_id, entity_kind, entity_id);",
    )?;
    Ok(())
}

fn table_row_counts(conn: &Connection) -> BTreeMap<String, i64> {
    let names = conn
        .prepare(
            "SELECT name
               FROM sqlite_master
              WHERE type = 'table'
                AND name NOT LIKE 'sqlite_%'
                AND name NOT LIKE '%\\_fts\\_%' ESCAPE '\\'",
        )
        .expect("prepare release fixture table list")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("read release fixture table list")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("collect release fixture table list");
    names
        .into_iter()
        .map(|name| {
            let quoted = format!("\"{}\"", name.replace('"', "\"\""));
            let count = conn
                .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or_else(|error| panic!("count release fixture table {name}: {error}"));
            (name, count)
        })
        .collect()
}

fn assert_seed_manifest_covers_row_deltas(
    before: &BTreeMap<String, i64>,
    after: &BTreeMap<String, i64>,
) {
    let changed_tables = after
        .iter()
        .filter(|(table, count)| before.get(*table).copied().unwrap_or_default() != **count)
        .map(|(table, _)| table.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let manifest_tables = LEGACY_SEED_TABLES
        .iter()
        .map(|descriptor| descriptor.table)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        changed_tables, manifest_tables,
        "every table changed by the previous-release seed must be represented by the exported legacy manifest"
    );
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
         VALUES (?1, ?2, NULL, 'folder', '第一部 gatea2folderneedle', 'a0', ?3, 0, 'outline')",
        params![FOLDER_ID, PROJECT_ID, "{}"],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, char_count, status)
         VALUES (?1, ?2, ?3, 'scene', '霧の港 gatea2sceneneedle', 'a1', ?4, 18, 'draft')",
        params![
            SCENE_ID,
            PROJECT_ID,
            FOLDER_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Gate A2 scene body 初稿"}]}]}"#
        ],
    )?;
    conn.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, tags_cache)
         VALUES (?1, ?2, 'character', '灯真', 'Toma gatea2codexneedle', 'Gate A2 codex summary', ?3, 'fixture')",
        params![
            CODEX_ID,
            PROJECT_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Codex body survives Gate A2"}]}]}"#
        ],
    )?;
    conn.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, tags_cache)
         VALUES ('gate-a2-related-codex', ?1, 'character', '凪', 'Nagi gatea2relatedcodexneedle', 'Related Gate A2 codex', ?2, 'fixture')",
        params![
            PROJECT_ID,
            r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Related codex body"}]}]}"#
        ],
    )?;
    conn.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             depth_hint, source_map_edge_id, created_at, updated_at)
         VALUES ('gate-a2-relation', ?1, ?2, 'gate-a2-related-codex', 'knows',
                 'Gate A2 relationship', 2, 'gate-a2-edge', '2026-01-02T03:04:05Z', '2026-01-02T03:04:06Z')",
        params![PROJECT_ID, CODEX_ID],
    )?;
    conn.execute(
        "INSERT INTO change_events
            (event_uid, project_id, scene_id, domain, op_type, entity_type, entity_id,
             payload, session_id, sequence, timestamp, prev_hash, hash)
         VALUES ('gate-a2-change-uid', ?1, ?2, 'scene', 'update', 'scene', ?2,
                 '{\"body\":\"Gate A2 change\"}', 'gate-a2-session', 1, 3000,
                 'gate-a2-prev-hash', 'gate-a2-hash')",
        params![PROJECT_ID, SCENE_ID],
    )?;
    conn.execute(
        "INSERT INTO undo_journal
            (id, project_id, surface, entity_kind, entity_id, op_kind, before_json,
             after_json, base_version, result_version, change_event_uid, created_at)
         VALUES ('gate-a2-undo', ?1, 'scene', 'scene', ?2, 'update',
                 '{\"body\":\"before\"}', '{\"body\":\"after\"}', 4, 5,
                 'gate-a2-change-uid', ?3)",
        params![PROJECT_ID, SCENE_ID, undo_journal_created_at()],
    )?;
    conn.execute(
        "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, start_time, start_granularity, precision, kind)
         VALUES (?1, ?2, '港での邂逅', 'Gate A2 chronicle event', 'a0', ?3, 42, 'day', 'exact', 'generic')",
        params![EVENT_ID, PROJECT_ID, CODEX_ID],
    )?;
    conn.execute(
        "INSERT INTO scene_events (scene_id, event_id, incarnation_token)
         VALUES (?1, ?2, 'gate-a2-scene@v0')",
        params![SCENE_ID, EVENT_ID],
    )?;
    conn.execute(
        "INSERT INTO chat_sessions (id, project_id, node_id, title)
         VALUES ('gate-a2-session', ?1, ?2, 'Gate A2 chat')",
        params![PROJECT_ID, SCENE_ID],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('gate-a2-user-message', 'gate-a2-session', 'user', '灯真の秘密を整理して gatea2chatuserneedle', NULL, 12, NULL)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('gate-a2-assistant-message', 'gate-a2-session', 'assistant', 'Gate A2 AI answer for audit chain gatea2chatassistantneedle', 'anthropic/claude-sonnet-4.6', 12, 34)",
        [],
    )?;
    conn.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, content_source, scene_id, source_chat_message_id)
         VALUES ('gate-a2-snippet', ?1, '抽出メモ gatea2snippetneedle', ?2, 'fixture', 'ai', ?3, 'gate-a2-assistant-message')",
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

    // Keep the migration-created default identity in the real previous-release
    // image as a second user project. This makes the two-project acceptance
    // exercise two genuine legacy projects instead of adding post-migration
    // source events that would be classified as a new source incarnation.
    conn.execute(
        "INSERT INTO projects (id, title, language, phase_resolution_mode)
         VALUES ('default-project', 'Default Release Fixture', 'ja', 'auto')",
        [],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label, is_builtin)
         VALUES ('default-project-type-character', 'default-project', 'character', 'Character', 1)",
        [],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, char_count, status)
         VALUES ('default-project-folder', 'default-project', NULL, 'folder', '第一部 defaultprojectfolderneedle', 'a0', '{}', 0, 'outline')",
        [],
    )?;
    conn.execute(
        "INSERT INTO tree_nodes (id, project_id, parent_id, node_type, title, sort_order, content, char_count, status)
         VALUES ('default-project-scene', 'default-project', 'default-project-folder', 'scene', '初回シーン defaultprojectsceneneedle', 'a1', ?1, 22, 'draft')",
        [r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Default release scene body"}]}]}"#],
    )?;
    conn.execute(
        "INSERT INTO codex_entries (id, project_id, type, name, aliases, summary, content, tags_cache)
         VALUES ('default-project-codex', 'default-project', 'character', 'Default Character', 'Default defaultprojectcodexneedle', 'Default release codex summary', ?1, 'fixture')",
        [r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Default codex body survives Gate A2"}]}]}"#],
    )?;
    conn.execute(
        "INSERT INTO events (id, project_id, title, note, ordinal, primary_codex_id, start_time, start_granularity, precision, kind)
         VALUES ('default-project-event', 'default-project', '初回の邂逅', 'Default release chronicle event', 'a0', 'default-project-codex', 84, 'day', 'exact', 'generic')",
        [],
    )?;
    conn.execute(
        "INSERT INTO scene_events (scene_id, event_id, incarnation_token)
         VALUES ('default-project-scene', 'default-project-event', 'default-project-scene@v0')",
        [],
    )?;
    conn.execute(
        "INSERT INTO chat_sessions (id, project_id, node_id, title)
         VALUES ('default-project-session', 'default-project', 'default-project-scene', 'Default release chat')",
        [],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('default-project-user-message', 'default-project-session', 'user', '初回シーンを整理して defaultprojectchatuserneedle', NULL, 10, NULL)",
        [],
    )?;
    conn.execute(
        "INSERT INTO chat_messages (id, session_id, role, content, model, tokens_in, tokens_out)
         VALUES ('default-project-assistant-message', 'default-project-session', 'assistant', 'Default release AI answer for audit chain defaultprojectchatassistantneedle', 'anthropic/claude-sonnet-4.6', 10, 28)",
        [],
    )?;
    conn.execute(
        "INSERT INTO snippets (id, project_id, title, content, tags_cache, content_source, scene_id, source_chat_message_id)
         VALUES ('default-project-snippet', 'default-project', '初回メモ defaultprojectsnippetneedle', ?1, 'fixture', 'ai', 'default-project-scene', 'default-project-assistant-message')",
        [r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Default release snippet"}]}]}"#],
    )?;
    conn.execute(
        "INSERT INTO project_settings (project_id, key, value)
         VALUES ('default-project', 'release-language', 'ja'), ('gate-a2-project', 'release-language', 'ja')",
        [],
    )?;
    conn.execute(
        "INSERT INTO map_boards (id, project_id, title, sort_order)
         VALUES ('default-project-board', 'default-project', 'Default release board', 0.0),
                ('gate-a2-board', 'gate-a2-project', 'Gate A2 release board', 0.0)",
        [],
    )?;
    conn.execute(
        r#"INSERT INTO ai_audit_events
            (scope_id, project_id, sequence, event_id, execution_id, operation_id,
             parent_execution_id, path_id, event_type, timestamp, recorded_at,
             payload, payload_sha256, prev_hash, hash)
         VALUES
            ('project:default-project', 'default-project', 1, 'default-project-audit-1', 'default-project-exec', 'default-project-op',
             NULL, 'chat/default-project-session', 'request', 2000, 2001,
             '{"kind":"request"}', 'default-payload-sha-1', 'GENESIS', 'default-hash-1')"#,
        [],
    )?;
    conn.execute(
        r#"INSERT INTO ai_audit_events
            (scope_id, project_id, sequence, event_id, execution_id, operation_id,
             parent_execution_id, path_id, event_type, timestamp, recorded_at,
             payload, payload_sha256, prev_hash, hash)
         VALUES
            ('project:default-project', 'default-project', 2, 'default-project-audit-2', 'default-project-exec', 'default-project-op',
             'default-project-exec-parent', 'chat/default-project-session', 'response', 2002, 2003,
             '{"kind":"response"}', 'default-payload-sha-2', 'default-hash-1', 'default-hash-2')"#,
        [],
    )?;
    conn.execute(
        "INSERT INTO app_settings (key, value)
         VALUES ('default-project.release-fixture', 'seeded')",
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

    let relation: (
        String,
        String,
        String,
        String,
        Option<i64>,
        Option<String>,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT project_id, from_codex_id, to_codex_id, relation_type,
                    depth_hint, source_map_edge_id, created_at, updated_at
               FROM codex_relations WHERE id = 'gate-a2-relation'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            },
        )
        .expect("codex relation row");
    assert_eq!(
        relation,
        (
            PROJECT_ID.into(),
            CODEX_ID.into(),
            "gate-a2-related-codex".into(),
            "knows".into(),
            Some(2),
            Some("gate-a2-edge".into()),
            "2026-01-02T03:04:05Z".into(),
            "2026-01-02T03:04:06Z".into()
        )
    );
    let relation_label: Option<String> = conn
        .query_row(
            "SELECT label FROM codex_relations WHERE id = 'gate-a2-relation'",
            [],
            |row| row.get(0),
        )
        .expect("codex relation label");
    assert_eq!(relation_label.as_deref(), Some("Gate A2 relationship"));

    let change_event: (
        i64,
        String,
        Option<String>,
        String,
        String,
        String,
        i64,
        i64,
        String,
        String,
    ) = conn
        .query_row(
            "SELECT id, project_id, scene_id, domain, op_type, entity_id,
                    sequence, timestamp, event_uid, hash
               FROM change_events WHERE event_uid = 'gate-a2-change-uid'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .expect("change event row");
    assert_eq!(
        change_event,
        (
            1,
            PROJECT_ID.into(),
            Some(SCENE_ID.into()),
            "scene".into(),
            "update".into(),
            SCENE_ID.into(),
            1,
            3000,
            "gate-a2-change-uid".into(),
            "gate-a2-hash".into()
        )
    );
    let change_event_body: (Option<String>, String, String, String) = conn
        .query_row(
            "SELECT entity_type, payload, session_id, prev_hash
               FROM change_events WHERE event_uid = 'gate-a2-change-uid'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("change event body columns");
    assert_eq!(
        change_event_body,
        (
            Some("scene".into()),
            r#"{"body":"Gate A2 change"}"#.into(),
            "gate-a2-session".into(),
            "gate-a2-prev-hash".into()
        )
    );

    let undo: UndoJournalRow = conn
        .query_row(
            "SELECT project_id, surface, entity_kind, entity_id, op_kind,
                    before_json, after_json, base_version, result_version,
                    change_event_uid, created_at
               FROM undo_journal WHERE id = 'gate-a2-undo'",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                ))
            },
        )
        .expect("undo journal row");
    assert_eq!(
        undo,
        (
            PROJECT_ID.into(),
            "scene".into(),
            "scene".into(),
            SCENE_ID.into(),
            "update".into(),
            Some("{\"body\":\"before\"}".into()),
            Some("{\"body\":\"after\"}".into()),
            4,
            5,
            Some("gate-a2-change-uid".into()),
            undo_journal_created_at().into()
        )
    );

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
