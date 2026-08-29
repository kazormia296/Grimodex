//! Local, file-based handoff from the hosted Web Editor into Electron.
//!
//! The browser exports its complete SQL.js workspace, so renderer-visible
//! project data survives without a lossy per-feature conversion. The native
//! boundary treats the JSON and SQLite image as untrusted: it validates the
//! exact envelope, bounds decoding, stages into a fresh generation, migrates
//! the database, and publishes only after integrity and manifest checks pass.

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rusqlite::{config::DbConfig, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::{
    protected_writers::bundled_protected_writer_registry,
    schema_contract::{inspect_connection, SchemaContract},
    workspace, AppResult, Database, GlobalSettingsPath,
};

pub const WEB_EDITOR_HANDOFF_SCHEMA_VERSION: &str = "grimodex/web-editor-workspace-handoff/1";
pub const MAX_WEB_EDITOR_DATABASE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HANDOFF_JSON_BYTES: usize = MAX_WEB_EDITOR_DATABASE_BYTES.div_ceil(3) * 4 + 16 * 1024;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";
const MAX_PROJECT_ID_LENGTH: usize = 96;
const MAX_TITLE_UTF16_LENGTH: usize = 200;
const DERIVED_FTS_TABLES: &[&str] = &[
    "chat_messages_fts",
    "chat_messages_fts_en",
    "codex_fts",
    "codex_fts_en",
    "post_effect_annotations_fts",
    "post_effect_annotations_fts_en",
    "snippets_fts",
    "snippets_fts_en",
    "tree_nodes_fts",
    "tree_nodes_fts_en",
];
const GENERATED_SCHEMA_CONTRACT: &str =
    include_str!("../../../../src/db/generated/schema-contract.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebEditorHandoffV1 {
    schema_version: String,
    encoding: String,
    database_base64: String,
    created_at: String,
    source_mode: String,
    ui_language: String,
    project_id: String,
    title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebEditorImportResult {
    pub path: String,
    pub project_id: String,
}

struct UnpublishedWorkspace {
    path: PathBuf,
    published: bool,
}

impl UnpublishedWorkspace {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            published: false,
        }
    }

    fn publish(&mut self) {
        self.published = true;
    }
}

impl Drop for UnpublishedWorkspace {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

fn validate_project_id(value: &str) -> anyhow::Result<()> {
    let valid = !value.is_empty()
        && value.len() <= MAX_PROJECT_ID_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'));
    if !valid {
        anyhow::bail!("invalid Web Editor handoff project id");
    }
    Ok(())
}

fn validate_title(value: &str) -> anyhow::Result<()> {
    let has_control_character = value.chars().any(char::is_control);
    if value.trim().is_empty()
        || value.encode_utf16().count() > MAX_TITLE_UTF16_LENGTH
        || has_control_character
    {
        anyhow::bail!("invalid Web Editor handoff title");
    }
    Ok(())
}

fn parse_handoff(handoff_json: &str) -> anyhow::Result<(WebEditorHandoffV1, Vec<u8>)> {
    if handoff_json.len() > MAX_HANDOFF_JSON_BYTES {
        anyhow::bail!("Web Editor handoff exceeds the size limit");
    }
    let handoff: WebEditorHandoffV1 = serde_json::from_str(handoff_json)?;
    if handoff.schema_version != WEB_EDITOR_HANDOFF_SCHEMA_VERSION {
        anyhow::bail!("unsupported Web Editor handoff schema version");
    }
    if handoff.encoding != "base64" {
        anyhow::bail!("unsupported Web Editor handoff encoding");
    }
    if handoff.source_mode != "scan" && handoff.source_mode != "standalone" {
        anyhow::bail!("invalid Web Editor handoff source mode");
    }
    if handoff.ui_language != "ja" && handoff.ui_language != "en" {
        anyhow::bail!("invalid Web Editor handoff UI language");
    }
    validate_project_id(&handoff.project_id)?;
    validate_title(&handoff.title)?;
    let parsed_time = chrono::DateTime::parse_from_rfc3339(&handoff.created_at)
        .map_err(|_| anyhow::anyhow!("invalid Web Editor handoff timestamp"))?;
    if parsed_time.offset().local_minus_utc() != 0
        || parsed_time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) != handoff.created_at
    {
        anyhow::bail!("invalid Web Editor handoff timestamp");
    }
    let max_encoded_len = MAX_WEB_EDITOR_DATABASE_BYTES.div_ceil(3) * 4;
    if handoff.database_base64.len() > max_encoded_len {
        anyhow::bail!("Web Editor handoff database exceeds the size limit");
    }
    let database = BASE64_STANDARD
        .decode(&handoff.database_base64)
        .map_err(|_| anyhow::anyhow!("invalid Web Editor handoff base64"))?;
    if database.len() > MAX_WEB_EDITOR_DATABASE_BYTES {
        anyhow::bail!("Web Editor handoff database exceeds the size limit");
    }
    if BASE64_STANDARD.encode(&database) != handoff.database_base64 {
        anyhow::bail!("Web Editor handoff base64 must be canonical");
    }
    if !database.starts_with(SQLITE_MAGIC) {
        anyhow::bail!("Web Editor handoff does not contain a SQLite database");
    }
    Ok((handoff, database))
}

fn harden_untrusted_connection(conn: &Connection) -> anyhow::Result<()> {
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    Ok(())
}

fn collect_schema_object_names(conn: &Connection, kind: &str) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT name FROM sqlite_master
         WHERE type = ?1 AND sql IS NOT NULL
         ORDER BY name",
    )?;
    let rows = statement.query_map([kind], |row| row.get::<_, String>(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn drop_schema_objects(conn: &Connection, kind: &str, names: Vec<String>) -> anyhow::Result<()> {
    for name in names {
        let quoted = name.replace('"', "\"\"");
        conn.execute_batch(&format!("DROP {kind} \"{quoted}\";"))?;
    }
    Ok(())
}

fn collect_allowed_derived_fts_tables(conn: &Connection) -> anyhow::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT tables.name, schema.sql
           FROM pragma_table_list AS tables
           JOIN sqlite_master AS schema
             ON schema.type = 'table' AND schema.name = tables.name
          WHERE tables.schema = 'main' AND tables.type = 'virtual'
          ORDER BY tables.name",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let virtual_tables = rows.collect::<Result<Vec<_>, _>>()?;

    for (name, create_sql) in &virtual_tables {
        let compact_sql = create_sql
            .chars()
            .filter(|character| !character.is_ascii_whitespace())
            .collect::<String>()
            .to_ascii_lowercase();
        let expected_prefix = format!("createvirtualtable{name}usingfts5(");
        if !DERIVED_FTS_TABLES.contains(&name.as_str())
            || !compact_sql.starts_with(&expected_prefix)
        {
            anyhow::bail!("Web Editor SQLite contains an unsupported virtual table: {name}");
        }
    }

    Ok(virtual_tables.into_iter().map(|(name, _)| name).collect())
}

fn table_exists(conn: &Connection, table: &str) -> anyhow::Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = ?1
         )",
        [table],
        |row| row.get(0),
    )?)
}

fn reject_untrusted_c2zc_boundary(conn: &Connection) -> anyhow::Result<()> {
    let marker_rows = Database::read_c2zc_cutover_marker_rows(conn).map_err(|error| {
        anyhow::anyhow!(
            "NEX_C2ZC_WEB_EDITOR_HANDOFF_BOUNDARY_READ_FAILED: cannot inspect C2-ZC cutover marker: {error}"
        )
    })?;
    if let Some((migration_id, contract_version)) = marker_rows.first() {
        anyhow::bail!(
            "NEX_C2ZC_WEB_EDITOR_HANDOFF_MARKER_REJECTED: schema_data_migrations contains C2-ZC cutover marker '{migration_id}' with contract version {contract_version}"
        );
    }

    let registry = bundled_protected_writer_registry();
    for entry in registry.c2zc_native_owned_entries() {
        let table_is_present = table_exists(conn, &entry.table).map_err(|error| {
            anyhow::anyhow!(
                "NEX_C2ZC_WEB_EDITOR_HANDOFF_BOUNDARY_READ_FAILED: cannot inspect native-owned C2-ZC table '{}': {error}",
                entry.table
            )
        })?;
        if !table_is_present {
            continue;
        }
        let quoted_table = entry.table.replace('"', "\"\"");
        let row_count: i64 = conn
            .query_row(
                &format!("SELECT COUNT(*) FROM \"{quoted_table}\""),
                [],
                |row| row.get(0),
            )
            .map_err(|error| {
                anyhow::anyhow!(
                    "NEX_C2ZC_WEB_EDITOR_HANDOFF_BOUNDARY_READ_FAILED: cannot count native-owned C2-ZC table '{}': {error}",
                    entry.table
                )
            })?;
        if row_count > 0 {
            anyhow::bail!(
                "NEX_C2ZC_WEB_EDITOR_HANDOFF_AUTHORITY_REJECTED: native-owned C2-ZC table '{}' contains {row_count} row(s)",
                entry.table
            );
        }
    }
    Ok(())
}

fn validate_staged_sqlite(path: &Path) -> anyhow::Result<()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    harden_untrusted_connection(&conn)?;
    reject_untrusted_c2zc_boundary(&conn)?;
    let quick_check: String = conn.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if quick_check != "ok" {
        anyhow::bail!("Web Editor SQLite integrity check failed: {quick_check}");
    }
    let user_version: i32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if user_version > grimodex_core::SCHEMA_VERSION {
        anyhow::bail!("Web Editor database was created by a newer Grimodex version");
    }

    let view_name: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type = 'view' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(view_name) = view_name {
        anyhow::bail!("Web Editor SQLite contains an unsupported view: {view_name}");
    }

    let derived_fts_tables = collect_allowed_derived_fts_tables(&conn)?;

    // Triggers and expression indexes are executable schema supplied by the
    // file. FTS virtual tables are derived search data as well. None contain
    // manuscript data, so rebuild them exclusively from the trusted native
    // migration rather than carrying their SQL across.
    drop_schema_objects(
        &conn,
        "TRIGGER",
        collect_schema_object_names(&conn, "trigger")?,
    )?;
    drop_schema_objects(&conn, "TABLE", derived_fts_tables)?;
    drop_schema_objects(&conn, "INDEX", collect_schema_object_names(&conn, "index")?)?;
    Ok(())
}

fn validate_manifest_project(
    database: &Database,
    project_id: &str,
    expected_title: &str,
) -> anyhow::Result<()> {
    database.with_conn(|conn| {
        let actual_title = conn
            .query_row(
                "SELECT title FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|_| anyhow::anyhow!("Web Editor handoff project was not found"))?;
        if actual_title != expected_title {
            anyhow::bail!("Web Editor handoff project title does not match the database");
        }
        let foreign_key_error: Option<String> = conn
            .query_row(
                "SELECT printf('%s:%s', \"table\", rowid) FROM pragma_foreign_key_check LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(error) = foreign_key_error {
            anyhow::bail!("Web Editor SQLite foreign-key check failed: {error}");
        }
        Ok(())
    })
}

fn expected_schema_contract() -> anyhow::Result<SchemaContract> {
    serde_json::from_str(GENERATED_SCHEMA_CONTRACT)
        .map_err(|error| anyhow::anyhow!("invalid embedded Grimodex schema contract: {error}"))
}

fn rebuild_trusted_schema_objects(
    database: &Database,
    expected: &SchemaContract,
) -> anyhow::Result<()> {
    database.with_conn(|conn| {
        drop_schema_objects(
            conn,
            "TRIGGER",
            collect_schema_object_names(conn, "trigger")?,
        )?;
        drop_schema_objects(conn, "INDEX", collect_schema_object_names(conn, "index")?)?;

        for (name, index) in &expected.indexes {
            let create_sql = index
                .create_sql
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("canonical index {name} has no CREATE SQL"))?;
            conn.execute_batch(create_sql)?;
        }
        for create_sql in expected.triggers.values() {
            conn.execute_batch(create_sql)?;
        }
        Ok(())
    })
}

fn validate_migrated_schema(database: &Database, expected: &SchemaContract) -> anyhow::Result<()> {
    let actual = database.with_conn(inspect_connection)?;

    if actual.schema_version != expected.schema_version {
        anyhow::bail!("Web Editor SQLite schema version did not migrate to the current version");
    }
    if !actual.tables.keys().eq(expected.tables.keys()) {
        anyhow::bail!("Web Editor SQLite contains an incomplete or unsupported table set");
    }

    for (name, expected_table) in &expected.tables {
        let actual_table = actual
            .tables
            .get(name)
            .ok_or_else(|| anyhow::anyhow!("Web Editor SQLite is missing table {name}"))?;
        if actual_table.kind != expected_table.kind
            || actual_table.columns != expected_table.columns
            || actual_table.foreign_keys != expected_table.foreign_keys
            || actual_table.unique_constraints != expected_table.unique_constraints
        {
            anyhow::bail!("Web Editor SQLite table schema is invalid: {name}");
        }
    }

    // Every supplied index and trigger was removed before migration. These
    // objects therefore must be byte-for-byte structural products of the
    // trusted native migration, not executable schema carried by the handoff.
    if actual.indexes != expected.indexes {
        let missing = expected
            .indexes
            .keys()
            .find(|name| !actual.indexes.contains_key(*name));
        let extra = actual
            .indexes
            .keys()
            .find(|name| !expected.indexes.contains_key(*name));
        let changed = expected.indexes.iter().find_map(|(name, contract)| {
            actual
                .indexes
                .get(name)
                .filter(|actual_contract| *actual_contract != contract)
                .map(|_| name)
        });
        anyhow::bail!(
            "Web Editor SQLite index schema is invalid (missing={:?}, extra={:?}, changed={:?})",
            missing,
            extra,
            changed
        );
    }
    if actual.triggers != expected.triggers {
        anyhow::bail!("Web Editor SQLite trigger schema is invalid");
    }
    Ok(())
}

/// Validate and materialize one Web Editor handoff as a fresh local workspace.
/// The caller opens the returned path through the ordinary workspace swap.
pub fn import_web_editor_workspace(
    gs_path: &GlobalSettingsPath,
    handoff_json: &str,
) -> AppResult<WebEditorImportResult> {
    import_web_editor_workspace_inner(gs_path, handoff_json).map_err(Into::into)
}

fn import_web_editor_workspace_inner(
    gs_path: &GlobalSettingsPath,
    handoff_json: &str,
) -> anyhow::Result<WebEditorImportResult> {
    let (handoff, database_bytes) = parse_handoff(handoff_json)?;
    let app_dir = gs_path
        .path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine AppData directory"))?;
    let generation_id = uuid::Uuid::new_v4().to_string();
    let workspace_path = app_dir.join(format!("web-editor-workspace-{generation_id}"));
    std::fs::create_dir(&workspace_path)?;
    let mut unpublished = UnpublishedWorkspace::new(workspace_path.clone());
    let database_path = workspace_path.join("grimodex.db");
    let mut database_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&database_path)?;
    database_file.write_all(&database_bytes)?;
    database_file.sync_all()?;
    drop(database_file);

    validate_staged_sqlite(&database_path)?;
    let database = Database::new(&database_path)?;
    database.with_conn(harden_untrusted_connection)?;
    database.migrate()?;
    let expected_schema = expected_schema_contract()?;
    rebuild_trusted_schema_objects(&database, &expected_schema)?;
    database.fts_rebuild()?;
    validate_migrated_schema(&database, &expected_schema)?;
    if let Some(report) = database.quick_check()? {
        anyhow::bail!("Web Editor SQLite integrity check failed: {report}");
    }
    validate_manifest_project(&database, &handoff.project_id, &handoff.title)?;
    drop(database);

    workspace::ensure_workspace_meta(
        &workspace_path,
        &generation_id,
        &chrono::Utc::now().to_rfc3339(),
    )?;
    let path = workspace_path
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow::anyhow!("Web Editor workspace path is not valid UTF-8"))?;
    unpublished.publish();
    Ok(WebEditorImportResult {
        path,
        project_id: handoff.project_id,
    })
}
