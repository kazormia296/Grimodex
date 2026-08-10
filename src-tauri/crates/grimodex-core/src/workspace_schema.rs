//! Read-only compatibility probes shared by desktop workspace open and MCP.
//!
//! # Gate B2 schema renumbering (append-only)
//!
//! - **v3** — physical invariants (ai_audit, stickies, live-comment repair, …)
//! - **v4** — `narrative_runtime_policy` singleton (Gate B Foundation)
//! - **v5** — `codex_detail_semantic_bindings`
//! - **v6** — project_calendar OCC `version` column
//! - **v7** — Narrative Extraction persistence tables
//! - **v8** — Codex relation directionality / semantic_key / version
//! - **v9** — Detail Definition / Detail Value OCC columns
//! - **v10** — Temporal Constraint Graph tables (Nodes / Constraints / Projections)
//!
//!
//! These probes deliberately avoid exact whole-schema comparison because
//! legitimate upgraded databases can differ from a freshly-created database in
//! column order and normalized DDL while remaining compatible.

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
    // The v2 → v3 marker-only fast path is frozen to schema 3. Schema 4+ must
    // run the full migrator so Native-owned tables (e.g. narrative_runtime_policy)
    // are created before the marker advances.
    if SCHEMA_VERSION != 3 || PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION != 3 {
        return Ok(false);
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != 2 {
        return Ok(false);
    }

    has_v3_physical_invariants(conn)
}

/// Whether a workspace carrying the immediately previous marker already
/// satisfies every current physical invariant and can therefore retain write
/// access while the desktop has not yet advanced the marker.
///
/// This function never mutates the connection. A `false` result asks the
/// caller to run the full idempotent migration; query failures remain errors so
/// corruption is not mistaken for an old-but-repairable schema.
pub fn is_previous_workspace_schema_write_compatible(conn: &Connection) -> anyhow::Result<bool> {
    // Fail closed after the next schema bump. The compatibility predicate must
    // always be reviewed together with the new physical checkpoint.
    if SCHEMA_VERSION != PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION {
        return Ok(false);
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version != PREVIOUS_COMPATIBLE_SCHEMA_VERSION {
        return Ok(false);
    }

    has_current_schema_checkpoint_invariants(conn)
}

/// Compatibility wrapper used by older call sites／tests that still name the
/// v3 checkpoint explicitly.
pub fn has_v3_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    has_v3_physical_invariants(conn)
}

/// Physical schema and data repairs introduced after v2 that every current
/// schema must still satisfy.
pub fn has_v3_physical_invariants(conn: &Connection) -> anyhow::Result<bool> {
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

/// SCHEMA 4 checkpoint: Native-owned Narrative runtime policy singleton.
///
/// Does **not** chain to v3 inside itself; callers that need the full stack
/// must invoke [`has_v3_physical_invariants`] (or a later checkpoint that does).
pub fn has_v4_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !table_exists(conn, "narrative_runtime_policy")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "narrative_runtime_policy")?;
    // INTEGER PRIMARY KEY reports notnull=0 in pragma_table_info even though it
    // is never NULL; match SQLite's physical report rather than SQL intent.
    let expected = [
        ("singleton_id", "INTEGER", false, 1),
        ("runtime_mode", "TEXT", true, 0),
        ("maintenance_enabled", "INTEGER", true, 0),
        ("generic_import_enabled", "INTEGER", true, 0),
        ("background_ai_enabled", "INTEGER", true, 0),
        ("version", "INTEGER", true, 0),
    ];
    if columns.len() != expected.len() {
        return Ok(false);
    }
    for (actual, (name, ty, not_null, pk)) in columns.iter().zip(expected) {
        if actual.name != name
            || actual.declared_type != ty
            || actual.not_null != not_null
            || actual.primary_key != pk
        {
            return Ok(false);
        }
    }
    let singleton: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_runtime_policy WHERE singleton_id = 1",
        [],
        |row| row.get(0),
    )?;
    Ok(singleton == 1)
}

/// SCHEMA 5 checkpoint: durable Detail semantic bindings on top of every v4
/// (runtime policy) invariant.
pub fn has_v5_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v4_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_detail_semantic_bindings")? {
        return Ok(false);
    }

    let columns = table_columns(conn, "codex_detail_semantic_bindings")?;
    let expected = [
        ("id", "TEXT", false, None, 1),
        ("project_id", "TEXT", true, None, 0),
        ("definition_id", "TEXT", true, None, 0),
        ("facet_key", "TEXT", true, None, 0),
        ("projection_kind", "TEXT", true, None, 0),
        ("temporal_policy", "TEXT", true, None, 0),
        ("source", "TEXT", true, None, 0),
        ("confirmed", "INTEGER", true, Some("0"), 0),
        ("version", "INTEGER", true, Some("0"), 0),
        ("created_at", "TEXT", true, Some("datetime('now')"), 0),
        ("updated_at", "TEXT", true, Some("datetime('now')"), 0),
    ];
    if columns.len() != expected.len()
        || columns.iter().zip(expected).any(|(actual, expected)| {
            actual.name != expected.0
                || actual.declared_type != expected.1
                || actual.not_null != expected.2
                || actual.default.as_deref() != expected.3
                || actual.primary_key != expected.4
        })
    {
        return Ok(false);
    }

    for (name, unique, expected_columns) in [
        (
            "uq_codex_detail_semantic_binding_definition_facet",
            true,
            &["definition_id", "facet_key"][..],
        ),
        (
            "idx_codex_detail_semantic_bindings_project_facet",
            false,
            &["project_id", "facet_key"][..],
        ),
    ] {
        let properties = conn
            .query_row(
                "SELECT \"unique\", partial
                   FROM pragma_index_list('codex_detail_semantic_bindings')
                  WHERE name = ?1",
                [name],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        if properties != Some((unique, false)) || index_columns(conn, name)? != expected_columns {
            return Ok(false);
        }
    }

    let owner_index = conn
        .query_row(
            "SELECT \"unique\", partial
               FROM pragma_index_list('codex_detail_definitions')
              WHERE name = 'uq_codex_detail_defs_project_id'",
            [],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?;
    if owner_index != Some((true, false))
        || index_columns(conn, "uq_codex_detail_defs_project_id")? != ["project_id", "id"]
    {
        return Ok(false);
    }

    let create_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_master
              WHERE type = 'table' AND name = 'codex_detail_semantic_bindings'",
            [],
            |row| row.get::<_, Option<String>>(0),
        )?
        .unwrap_or_default();
    let compact = compact_sql(&create_sql);
    for required in [
        "check(projection_kindin('scalar-text','summary-text','enum','entity-reference'))",
        "check(temporal_policyin('base-only','phase-on-durable-change','base-and-phase','derived','manual-only'))",
        "check(sourcein('preset','user','reviewed-ai'))",
        "check(confirmedin(0,1))",
        "check(version>=0)",
        "project_idtextnotnullreferencesprojects(id)ondeletecascade",
        "foreignkey(project_id,definition_id)referencescodex_detail_definitions(project_id,id)ondeletecascade",
    ] {
        if !compact.contains(required) {
            return Ok(false);
        }
    }

    Ok(true)
}

/// SCHEMA 6 checkpoint: Calendar OCC token on top of every v5 invariant.
pub fn has_v6_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v5_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "project_calendar")? {
        return Ok(false);
    }

    let columns = table_columns(conn, "project_calendar")?;
    Ok(columns.iter().any(|column| {
        column.name == "version"
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("0")
            && column.primary_key == 0
    }))
}


/// SCHEMA 7 checkpoint: Narrative Extraction persistence on top of every v6
/// invariant.
pub fn has_v7_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v6_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    Ok(table_exists(conn, "narrative_extraction_runs")?
        && table_exists(conn, "narrative_proposals")?
        && table_exists(conn, "narrative_apply_commits")?)
}

/// SCHEMA 8 checkpoint: Codex relation directionality / semantic_key / version.
pub fn has_v8_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v7_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_relations")? {
        return Ok(false);
    }
    let columns = table_columns(conn, "codex_relations")?;
    let has_directionality = columns.iter().any(|column| {
        column.name == "directionality"
            && column.declared_type == "TEXT"
            && column.not_null
    });
    let has_inverse_label = columns.iter().any(|column| column.name == "inverse_label");
    let has_semantic_key = columns.iter().any(|column| {
        column.name == "semantic_key" && column.declared_type == "TEXT" && column.not_null
    });
    let has_version = columns.iter().any(|column| {
        column.name == "version"
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("1")
    });
    Ok(has_directionality && has_inverse_label && has_semantic_key && has_version)
}

/// SCHEMA 9 checkpoint: Detail Definition / Detail Value OCC columns on top of
/// every v8 invariant.
pub fn has_v9_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if !has_v8_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    if !table_exists(conn, "codex_detail_definitions")?
        || !table_exists(conn, "codex_detail_values")?
    {
        return Ok(false);
    }
    let definitions = table_columns(conn, "codex_detail_definitions")?;
    let values = table_columns(conn, "codex_detail_values")?;
    Ok(
        has_occ_integer_column(&definitions, "version")
            && has_timestamp_text_column(&definitions, "updated_at")
            && has_occ_integer_column(&values, "version")
            && has_timestamp_text_column(&values, "created_at")
            && has_timestamp_text_column(&values, "updated_at"),
    )
}

/// Whether the live DB satisfies every checkpoint invariant for the *current*
/// [`SCHEMA_VERSION`]. Version 10 adds the Temporal Constraint Graph
/// persistence tables (`narrative_temporal_nodes`,
/// `narrative_temporal_constraints`, `narrative_temporal_projections`) on top
/// of every v9 invariant.
pub fn has_current_schema_checkpoint_invariants(conn: &Connection) -> anyhow::Result<bool> {
    if SCHEMA_VERSION != 10 || !has_v3_physical_invariants(conn)? {
        return Ok(false);
    }
    if !has_v9_checkpoint_invariants(conn)? {
        return Ok(false);
    }
    for table in [
        "narrative_temporal_nodes",
        "narrative_temporal_constraints",
        "narrative_temporal_projections",
    ] {
        if !table_exists(conn, table)? {
            return Ok(false);
        }
    }
    let nodes = table_columns(conn, "narrative_temporal_nodes")?;
    let constraints = table_columns(conn, "narrative_temporal_constraints")?;
    let projections = table_columns(conn, "narrative_temporal_projections")?;
    Ok(
        has_occ_integer_column(&nodes, "version")
            && has_timestamp_text_column(&nodes, "created_at")
            && has_timestamp_text_column(&nodes, "updated_at")
            && has_occ_integer_column(&constraints, "version")
            && has_timestamp_text_column(&constraints, "created_at")
            && has_timestamp_text_column(&constraints, "updated_at")
            && has_occ_integer_column(&projections, "version")
            && has_timestamp_text_column(&projections, "created_at")
            && has_timestamp_text_column(&projections, "updated_at"),
    )
}

fn has_occ_integer_column(columns: &[ColumnShape], name: &str) -> bool {
    columns.iter().any(|column| {
        column.name == name
            && column.declared_type == "INTEGER"
            && column.not_null
            && column.default.as_deref() == Some("0")
    })
}

fn has_timestamp_text_column(columns: &[ColumnShape], name: &str) -> bool {
    columns.iter().any(|column| {
        column.name == name
            && column.declared_type == "TEXT"
            && column.not_null
    })
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
    fn schema_4_disables_v2_marker_fast_path() {
        let conn = converged_v2_connection();
        assert!(!is_converged_v2_workspace_schema(&conn).expect("inspect fixture"));
        assert!(has_v3_physical_invariants(&conn).expect("v3 physical still holds"));
    }

    #[test]
    fn recognizes_the_historical_v3_checkpoint_but_does_not_skip_v4() {
        let conn = converged_v2_connection();
        assert!(has_v3_checkpoint_invariants(&conn).expect("inspect v3 fixture"));
        // Current is v7; previous-marker write compat needs full current invariants.
        assert!(!is_previous_workspace_schema_write_compatible(&conn)
            .expect("inspect current compatibility"));

        conn.execute_batch("DROP INDEX idx_ai_audit_scope_timestamp")
            .expect("remove required index");
        assert!(!has_v3_checkpoint_invariants(&conn).expect("inspect partial fixture"));
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

        assert!(!has_v3_physical_invariants(&conn).expect("inspect legacy metadata"));
    }

    #[test]
    fn rejects_v2_schema_without_editor_stickies() {
        let conn = converged_v2_connection();
        conn.execute_batch("DROP TABLE editor_stickies")
            .expect("remove editor sticky invariant");

        assert!(!has_v3_physical_invariants(&conn).expect("inspect missing stickies"));
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

        assert!(!has_v3_physical_invariants(&conn).expect("inspect partial index"));
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

        assert!(!has_v3_physical_invariants(&conn).expect("inspect missing CHECK"));
    }

    #[test]
    fn v4_checkpoint_requires_singleton_policy_row() {
        let conn = converged_v2_connection();
        assert!(!has_v4_checkpoint_invariants(&conn).expect("missing table"));
        conn.execute_batch(
            "CREATE TABLE narrative_runtime_policy (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                runtime_mode TEXT NOT NULL,
                maintenance_enabled INTEGER NOT NULL,
                generic_import_enabled INTEGER NOT NULL,
                background_ai_enabled INTEGER NOT NULL,
                version INTEGER NOT NULL DEFAULT 1
             );
             INSERT INTO narrative_runtime_policy (
                singleton_id, runtime_mode, maintenance_enabled,
                generic_import_enabled, background_ai_enabled, version
             ) VALUES (1, 'review-only', 0, 0, 0, 1);",
        )
        .expect("create policy");
        assert!(has_v4_checkpoint_invariants(&conn).expect("policy present"));
    }
}
