//! Read-only compatibility probes shared by desktop workspace open and MCP.
//!
//! Schema version 2 was already released when the live-comment metadata repair
//! and the complete AI audit ledger were added. Consequently, version 2 alone
//! cannot prove that a workspace has converged to the schema represented by
//! version 3. This module checks only those post-v2 invariants; it deliberately
//! avoids exact whole-schema comparison because legitimate upgraded databases
//! can differ from a freshly-created database in column order and normalized
//! DDL while remaining compatible.

use rusqlite::{Connection, OptionalExtension};

use crate::{
    PREVIOUS_COMPATIBLE_SCHEMA_VERSION, PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION, SCHEMA_VERSION,
};

const AI_AUDIT_COLUMNS: &[(&str, &str, bool, i32)] = &[
    ("id", "INTEGER", false, 1),
    ("scope_id", "TEXT", true, 0),
    ("project_id", "TEXT", false, 0),
    ("sequence", "INTEGER", true, 0),
    ("event_id", "TEXT", true, 0),
    ("execution_id", "TEXT", true, 0),
    ("operation_id", "TEXT", true, 0),
    ("parent_execution_id", "TEXT", false, 0),
    ("path_id", "TEXT", true, 0),
    ("event_type", "TEXT", true, 0),
    ("timestamp", "INTEGER", true, 0),
    ("recorded_at", "INTEGER", true, 0),
    ("payload", "TEXT", true, 0),
    ("payload_sha256", "TEXT", true, 0),
    ("prev_hash", "TEXT", true, 0),
    ("hash", "TEXT", true, 0),
];

const AI_AUDIT_INDEXES: &[(&str, bool, &[&str])] = &[
    ("uq_ai_audit_scope_seq", true, &["scope_id", "sequence"]),
    ("uq_ai_audit_scope_event", true, &["scope_id", "event_id"]),
    (
        "idx_ai_audit_scope_execution",
        false,
        &["scope_id", "execution_id", "sequence"],
    ),
    (
        "idx_ai_audit_scope_execution_event_type",
        false,
        &["scope_id", "execution_id", "event_type"],
    ),
    (
        "idx_ai_audit_scope_operation",
        false,
        &["scope_id", "operation_id", "sequence"],
    ),
    (
        "idx_ai_audit_scope_timestamp",
        false,
        &["scope_id", "timestamp", "sequence"],
    ),
];

/// Whether a released v2 workspace already satisfies every migration added
/// after v2 and can therefore use the v3 open fast path without a schema write.
///
/// This function never mutates the connection. A `false` result asks the
/// caller to run the full idempotent migration; query failures remain errors so
/// corruption is not mistaken for an old-but-repairable schema.
pub fn is_converged_v2_workspace_schema(conn: &Connection) -> anyhow::Result<bool> {
    // Fail closed after the next schema bump. The invariants below prove only
    // the explicit v2 -> v3 marker-only transition and must be revisited for a
    // different target schema.
    if SCHEMA_VERSION != PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION {
        return Ok(false);
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != PREVIOUS_COMPATIBLE_SCHEMA_VERSION {
        return Ok(false);
    }

    has_v3_checkpoint_invariants(conn)
}

/// Whether the physical schema and data repairs introduced after v2 satisfy
/// the checkpoint represented by schema version 3.
///
/// Unlike [`is_converged_v2_workspace_schema`], this does not inspect
/// `user_version`; the full migrator uses it immediately before stamping v3 so
/// malformed same-name tables or indexes cannot be advertised as current.
pub fn has_v3_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if SCHEMA_VERSION != PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION {
        return Ok(false);
    }

    for table in [
        "ai_audit_events",
        "post_effect_runs",
        "post_effect_annotations",
        "editor_stickies",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }

    let audit_columns = table_columns(conn, "ai_audit_events")?;
    if audit_columns.len() != AI_AUDIT_COLUMNS.len()
        || audit_columns
            .iter()
            .zip(AI_AUDIT_COLUMNS)
            .any(|(actual, expected)| {
                actual.name != expected.0
                    || actual.declared_type != expected.1
                    || actual.not_null != expected.2
                    || actual.default.is_some()
                    || actual.primary_key != expected.3
            })
    {
        return Ok(false);
    }

    let create_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ai_audit_events'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?
        .unwrap_or_default();
    let compact_sql = compact_sql(&create_sql);
    if !compact_sql.contains("idintegerprimarykeyautoincrement")
        || !compact_sql.contains(
            "check((scope_id='workspace'andproject_idisnull)or(project_idisnotnullandscope_id='project:'||project_id))",
        )
    {
        return Ok(false);
    }

    for (name, expected_unique, expected_columns) in AI_AUDIT_INDEXES {
        let properties = conn
            .query_row(
                "SELECT \"unique\", partial
                   FROM pragma_index_list('ai_audit_events')
                  WHERE name = ?1",
                [*name],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if properties != Some((*expected_unique, false))
            || index_columns(conn, name)? != *expected_columns
        {
            return Ok(false);
        }
    }

    let has_foreign_key: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM pragma_foreign_key_list('ai_audit_events')
        )",
        [],
        |row| row.get(0),
    )?;
    if has_foreign_key {
        return Ok(false);
    }

    let has_unrepaired_live_comment: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM post_effect_annotations AS annotation
              JOIN post_effect_runs AS run ON run.id = annotation.run_id
             WHERE annotation.category = 'pseudo_comment'
               AND run.prompt_version = 'pseudo_comment_live_v1.0'
               AND COALESCE(
                     CASE
                       WHEN json_valid(annotation.metadata)
                       THEN json_extract(annotation.metadata, '$.live')
                       ELSE NULL
                     END,
                     0
                   ) != 1
             LIMIT 1
        )",
        [],
        |row| row.get(0),
    )?;

    Ok(!has_unrepaired_live_comment)
}

fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
        )",
        [table],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

struct ColumnShape {
    name: String,
    declared_type: String,
    not_null: bool,
    default: Option<String>,
    primary_key: i32,
}

fn table_columns(conn: &Connection, table: &str) -> anyhow::Result<Vec<ColumnShape>> {
    let mut statement = conn.prepare(
        "SELECT name, type, \"notnull\", dflt_value, pk
           FROM pragma_table_info(?1)
          ORDER BY cid",
    )?;
    let columns = statement
        .query_map([table], |row| {
            Ok(ColumnShape {
                name: row.get(0)?,
                declared_type: row.get::<_, String>(1)?.to_ascii_uppercase(),
                not_null: row.get(2)?,
                default: row.get(3)?,
                primary_key: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(columns)
}

fn index_columns(conn: &Connection, index: &str) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")?;
    let columns = statement
        .query_map([index], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    Ok(columns)
}

fn compact_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn converged_v2_connection() -> Connection {
        let conn = Connection::open_in_memory().expect("open fixture database");
        conn.execute_batch(
            "PRAGMA user_version = 2;
             CREATE TABLE ai_audit_events (
                id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id            TEXT NOT NULL,
                project_id          TEXT,
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
             CREATE UNIQUE INDEX uq_ai_audit_scope_seq
                ON ai_audit_events(scope_id, sequence);
             CREATE UNIQUE INDEX uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id);
             CREATE INDEX idx_ai_audit_scope_execution
                ON ai_audit_events(scope_id, execution_id, sequence);
             CREATE INDEX idx_ai_audit_scope_execution_event_type
                ON ai_audit_events(scope_id, execution_id, event_type);
             CREATE INDEX idx_ai_audit_scope_operation
                ON ai_audit_events(scope_id, operation_id, sequence);
             CREATE INDEX idx_ai_audit_scope_timestamp
                ON ai_audit_events(scope_id, timestamp, sequence);
             CREATE TABLE post_effect_runs (
                id TEXT PRIMARY KEY,
                prompt_version TEXT NOT NULL
             );
             CREATE TABLE post_effect_annotations (
                id TEXT PRIMARY KEY,
                run_id TEXT NOT NULL,
                category TEXT NOT NULL,
                metadata TEXT
             );
             CREATE TABLE editor_stickies (
                id TEXT PRIMARY KEY
             );",
        )
        .expect("create converged v2 fixture");
        conn
    }

    #[test]
    fn accepts_only_converged_v2_schema() {
        let conn = converged_v2_connection();
        assert!(is_converged_v2_workspace_schema(&conn).expect("inspect fixture"));

        conn.execute_batch("DROP INDEX idx_ai_audit_scope_timestamp")
            .expect("remove required index");
        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect partial fixture"));
    }

    #[test]
    fn rejects_unrepaired_live_comment_metadata() {
        let conn = converged_v2_connection();
        conn.execute(
            "INSERT INTO post_effect_runs (id, prompt_version)
             VALUES ('live-run', 'pseudo_comment_live_v1.0')",
            [],
        )
        .expect("insert live run");
        conn.execute(
            "INSERT INTO post_effect_annotations (id, run_id, category, metadata)
             VALUES ('live-ann', 'live-run', 'pseudo_comment', '{}')",
            [],
        )
        .expect("insert unrepaired annotation");

        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect legacy metadata"));
    }

    #[test]
    fn rejects_v2_schema_without_editor_stickies() {
        let conn = converged_v2_connection();
        conn.execute_batch("DROP TABLE editor_stickies")
            .expect("remove editor sticky invariant");

        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect missing stickies"));
    }

    #[test]
    fn rejects_partial_audit_index() {
        let conn = converged_v2_connection();
        conn.execute_batch(
            "DROP INDEX uq_ai_audit_scope_event;
             CREATE UNIQUE INDEX uq_ai_audit_scope_event
                ON ai_audit_events(scope_id, event_id)
                WHERE 0;",
        )
        .expect("replace required index with partial index");

        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect partial index"));
    }

    #[test]
    fn rejects_audit_schema_without_scope_constraint() {
        let conn = converged_v2_connection();
        conn.execute_batch(
            "DROP TABLE ai_audit_events;
             CREATE TABLE ai_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope_id TEXT NOT NULL,
                project_id TEXT,
                sequence INTEGER NOT NULL,
                event_id TEXT NOT NULL,
                execution_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                parent_execution_id TEXT,
                path_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                recorded_at INTEGER NOT NULL,
                payload TEXT NOT NULL,
                payload_sha256 TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
             );",
        )
        .expect("replace audit table without CHECK");

        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect missing CHECK"));
    }
}
