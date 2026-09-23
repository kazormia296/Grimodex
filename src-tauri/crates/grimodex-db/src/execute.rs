use rusqlite::{
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter, Connection, ErrorCode,
};
use serde_json::Value;
use std::cell::{Cell, RefCell};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

use super::protected_writers::{
    bundled_protected_writer_registry, classify_insert_columns, untrusted_mutation_rejection,
    PROTECTED_WRITER_SQL_ERROR,
};
use super::{BatchStatement, Database};

/// Phase 5 instrumentation: log when a single in-Rust DB call takes long
/// enough to plausibly cause a UI hitch. Split between `lock_wait` (time
/// blocked on `Database.conn.lock()`) and `sql` (time inside the connection
/// running the actual statements). The command-layer log adds a `total=`
/// figure so ws_state lock contention can be derived as
/// `total - lock_wait - sql`.
const SLOW_DB_CALL_MS: u128 = 50;

/// Stable prefix propagated through N-API and the Electron IPC envelope when
/// renderer-origin SQL attempts to cross the workspace/file/schema boundary.
pub const RENDERER_SQL_SECURITY_ERROR: &str = "RENDERER_SQL_SECURITY";

/// Stored typed NIR-1 Evidence shares the legacy proposal payload columns.
/// Renderer SQL has no row-safe publication predicate, so these columns stay
/// Native-only until the explicit D2a plaintext publication gate exists.
pub const RENDERER_TYPED_PAYLOAD_ERROR: &str = "RENDERER_SQL_TYPED_PAYLOAD";

/// Stable marker returned when D2a's Native SQL publication guard rejects a
/// protected read or a statement that would return DML result plaintext.
pub const RENDERER_PROFILE_EGRESS_ERROR: &str = "D2A_EGRESS_DENIED";

/// SQL caller classification shared by Electron, Tauri, and MCP.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqlOrigin {
    /// Renderer generic SQL proxy (Drizzle / raw).
    Renderer,
    /// MCP generic／untrusted SQL surface.
    McpGeneric,
    /// Typed domain writers owned by Native.
    TrustedDomainWriter,
    /// Migration supervisor / schema upgrades.
    TrustedMigration,
}

/// Result metadata used by the Native profile-egress adapter.  SQLite's
/// prepared statement is the authority for whether the executed statement can
/// mutate the database; callers must not infer this from the SQL spelling or
/// the Drizzle method name.
#[derive(Debug)]
pub struct SqlExecutionResult {
    pub rows: Vec<serde_json::Map<String, Value>>,
    pub statement_may_mutate: bool,
}

impl SqlOrigin {
    pub fn is_untrusted(self) -> bool {
        matches!(self, Self::Renderer | Self::McpGeneric)
    }
}

thread_local! {
    static UNTRUSTED_SQL_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static PENDING_INSERT_COLUMNS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
    /// Set only while the Electron Native D2a generic-DB adapter is running.
    /// The ordinary renderer policy remains backwards-compatible; D2a adds a
    /// publication guard on top of the same SQLite authorizer.
    static PROFILE_EGRESS_SQL_ACTIVE: Cell<bool> = const { Cell::new(false) };
    /// Only the batch runner may issue transaction controls. Payload SQL is
    /// always evaluated with this disabled, even while the runner-owned
    /// BEGIN/COMMIT/ROLLBACK is executing under the same authorizer.
    static RUNNER_TRANSACTION_CONTROL_ALLOWED: Cell<bool> = const { Cell::new(false) };
}

const RENDERER_SQL_RESOURCE_ERROR: &str = "RENDERER_SQL_RESOURCE_LIMIT";
const RENDERER_SQL_LENGTH_LIMIT: i32 = 1_048_576;
const RENDERER_VDBE_OP_LIMIT: i32 = 250_000;
const RENDERER_PROGRESS_INTERVAL: i32 = 10_000;
const RENDERER_MAX_PROGRESS_CALLBACKS: usize = 5_000;

const RESERVED_PROJECT_SETTING_INSERT_TRIGGER: &str =
    "grimodex_guard_reserved_project_setting_insert";
const RESERVED_PROJECT_SETTING_UPDATE_TRIGGER: &str =
    "grimodex_guard_reserved_project_setting_update";
const RESERVED_PROJECT_SETTING_DELETE_TRIGGER: &str =
    "grimodex_guard_reserved_project_setting_delete";

const RESERVED_PROJECT_SETTING_GUARD_SQL: &str = r#"
CREATE TEMP TRIGGER grimodex_guard_reserved_project_setting_insert
BEFORE INSERT ON main.project_settings
WHEN NEW.key IN ('scan.import.state', 'timelapse.enabled', 'timelapse.resetSequence')
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED_WRITER_SQL: denied mutation of reserved project setting');
END;
CREATE TEMP TRIGGER grimodex_guard_reserved_project_setting_update
BEFORE UPDATE ON main.project_settings
WHEN OLD.key IN ('scan.import.state', 'timelapse.enabled', 'timelapse.resetSequence')
  OR NEW.key IN ('scan.import.state', 'timelapse.enabled', 'timelapse.resetSequence')
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED_WRITER_SQL: denied mutation of reserved project setting');
END;
CREATE TEMP TRIGGER grimodex_guard_reserved_project_setting_delete
BEFORE DELETE ON main.project_settings
WHEN OLD.key IN ('scan.import.state', 'timelapse.enabled', 'timelapse.resetSequence')
BEGIN
  SELECT RAISE(ABORT, 'PROTECTED_WRITER_SQL: denied mutation of reserved project setting');
END;
"#;

fn drop_reserved_project_setting_guard(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "DROP TRIGGER IF EXISTS temp.{RESERVED_PROJECT_SETTING_INSERT_TRIGGER};
         DROP TRIGGER IF EXISTS temp.{RESERVED_PROJECT_SETTING_UPDATE_TRIGGER};
         DROP TRIGGER IF EXISTS temp.{RESERVED_PROJECT_SETTING_DELETE_TRIGGER};"
    ))
}

fn install_reserved_project_setting_guard(conn: &Connection) -> rusqlite::Result<()> {
    let table_exists: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM main.sqlite_master
             WHERE type = 'table' AND name = 'project_settings'
         )",
        [],
        |row| row.get(0),
    )?;
    if !table_exists {
        return Ok(());
    }

    // Clear any partial installation before creating the complete set. The
    // policy cleanup repeats this after removing the authorizer, so a setup
    // error cannot strand a trigger on the shared connection.
    drop_reserved_project_setting_guard(conn)?;
    conn.execute_batch(RESERVED_PROJECT_SETTING_GUARD_SQL)
}

fn log_prefix(sql: &str) -> String {
    let trimmed = sql.trim_start();
    let head: String = trimmed.chars().take(80).collect();
    head.replace('\n', " ")
}

fn renderer_pragma_allowed(name: &str, value: Option<&str>) -> bool {
    if name.eq_ignore_ascii_case("defer_foreign_keys") {
        return value.is_some_and(|value| {
            ["1", "on", "true"]
                .iter()
                .any(|allowed| value.trim().eq_ignore_ascii_case(allowed))
        });
    }

    // Read-only schema/query-planner introspection used by Drizzle contract
    // checks and source-revision reads. Their argument is an object name, not a
    // setting mutation.
    [
        "data_version",
        "foreign_key_list",
        "foreign_keys",
        "index_info",
        "index_list",
        "index_xinfo",
        "schema_version",
        "table_info",
        "table_xinfo",
        "user_version",
    ]
    .iter()
    .any(|allowed| name.eq_ignore_ascii_case(allowed))
        && (value.is_none()
            || [
                "foreign_key_list",
                "index_info",
                "index_list",
                "index_xinfo",
                "table_info",
                "table_xinfo",
            ]
            .iter()
            .any(|allowed| name.eq_ignore_ascii_case(allowed)))
}

fn renderer_function_denied(name: &str) -> bool {
    [
        "edit",
        "eval",
        "fts3_tokenizer",
        "load_extension",
        "readfile",
        "writefile",
    ]
    .iter()
    .any(|denied| name.eq_ignore_ascii_case(denied))
}

fn protected_writer_rejection(ctx: &AuthContext<'_>) -> Option<String> {
    // Only the canonical message mutation triggers may irreversibly revoke a
    // Native version. Renderer DDL is denied, so it cannot forge an accessor.
    // This exception grants no direct table writes or version qualification.
    if matches!(ctx.action, AuthAction::Update { table_name, column_name }
        if table_name == "nir1_generation_message_versions" && column_name == "invalidated")
        && matches!(ctx.accessor, Some("nir1_generation_invalidate_message_update"
            | "nir1_generation_invalidate_message_delete"
            | "nir1_generation_invalidate_message_insert"))
    {
        return None;
    }
    let registry = bundled_protected_writer_registry();
    match &ctx.action {
        AuthAction::Delete { table_name } => {
            untrusted_mutation_rejection(registry, table_name, None, false, true, None)
        }
        AuthAction::Insert { table_name } => {
            let insert_columns = PENDING_INSERT_COLUMNS.with(|columns| columns.borrow().clone());
            untrusted_mutation_rejection(
                registry,
                table_name,
                None,
                true,
                false,
                insert_columns.as_deref(),
            )
        }
        AuthAction::Update {
            table_name,
            column_name,
        } => untrusted_mutation_rejection(
            registry,
            table_name,
            Some(column_name),
            false,
            false,
            None,
        ),
        _ => None,
    }
}

fn renderer_typed_payload_read_rejection(ctx: &AuthContext<'_>) -> Option<String> {
    let AuthAction::Read {
        table_name,
        column_name,
    } = &ctx.action
    else {
        return None;
    };

    let protected_table = table_name.eq_ignore_ascii_case("narrative_proposals")
        || table_name.eq_ignore_ascii_case("narrative_proposal_revisions");
    if protected_table && column_name.eq_ignore_ascii_case("payload_json") {
        Some(format!(
            "{RENDERER_TYPED_PAYLOAD_ERROR}: {table_name}.{column_name} contains Native-only typed payload"
        ))
    } else {
        None
    }
}

fn renderer_sql_rejection(ctx: AuthContext<'_>) -> Option<String> {
    if !matches!(ctx.database_name, None | Some("main") | Some("temp")) {
        return Some("access to an attached database".to_string());
    }

    let mutates_ai_audit = match &ctx.action {
        AuthAction::Delete { table_name }
        | AuthAction::Insert { table_name }
        | AuthAction::Update { table_name, .. } => {
            table_name.eq_ignore_ascii_case("ai_audit_events")
        }
        _ => false,
    };
    if mutates_ai_audit {
        return Some("mutation of ai_audit_events".to_string());
    }

    if let Some(reason) = renderer_typed_payload_read_rejection(&ctx) {
        return Some(reason);
    }

    if let Some(reason) = protected_writer_rejection(&ctx) {
        return Some(reason);
    }

    match ctx.action {
        AuthAction::Attach { .. } => Some("ATTACH or VACUUM".to_string()),
        AuthAction::Detach { .. } => Some("DETACH".to_string()),
        AuthAction::CreateIndex { .. }
        | AuthAction::CreateTable { .. }
        | AuthAction::CreateTempIndex { .. }
        | AuthAction::CreateTempTable { .. }
        | AuthAction::CreateTempTrigger { .. }
        | AuthAction::CreateTempView { .. }
        | AuthAction::CreateTrigger { .. }
        | AuthAction::CreateView { .. }
        | AuthAction::DropIndex { .. }
        | AuthAction::DropTable { .. }
        | AuthAction::DropTempIndex { .. }
        | AuthAction::DropTempTable { .. }
        | AuthAction::DropTempTrigger { .. }
        | AuthAction::DropTempView { .. }
        | AuthAction::DropTrigger { .. }
        | AuthAction::DropView { .. }
        | AuthAction::AlterTable { .. }
        | AuthAction::Reindex { .. }
        | AuthAction::Analyze { .. } => Some("schema operation".to_string()),
        AuthAction::CreateVtable { .. } | AuthAction::DropVtable { .. } => {
            Some("virtual table operation".to_string())
        }
        AuthAction::Pragma {
            pragma_name,
            pragma_value,
        } if !renderer_pragma_allowed(pragma_name, pragma_value) => {
            Some(format!("PRAGMA {pragma_name}"))
        }
        AuthAction::Function { function_name } if renderer_function_denied(function_name) => {
            Some(format!("function {function_name}"))
        }
        AuthAction::Transaction { .. } | AuthAction::Savepoint { .. }
            if !RUNNER_TRANSACTION_CONTROL_ALLOWED.with(Cell::get) =>
        {
            Some("transaction control".to_string())
        }
        AuthAction::Delete { .. }
        | AuthAction::Insert { .. }
        | AuthAction::Pragma { .. }
        | AuthAction::Read { .. }
        | AuthAction::Select
        | AuthAction::Transaction { .. }
        | AuthAction::Update { .. }
        | AuthAction::Function { .. }
        | AuthAction::Savepoint { .. }
        | AuthAction::Recursive => None,
        // rusqlite maps ATTACH/DETACH to `Unknown` when a bound parameter
        // means SQLite cannot provide arg1 during prepare.
        AuthAction::Unknown { code, .. } if code == rusqlite::ffi::SQLITE_ATTACH => {
            Some("ATTACH or VACUUM".to_string())
        }
        AuthAction::Unknown { code, .. } if code == rusqlite::ffi::SQLITE_DETACH => {
            Some("DETACH".to_string())
        }
        AuthAction::Unknown { code, arg1, arg2 } => Some(format!(
            "unknown SQLite operation code={code} arg1={arg1:?} arg2={arg2:?}"
        )),
        // Fail closed when a future SQLite/rusqlite release adds a new
        // authorizer action. It must be reviewed before renderer SQL can use it.
        _ => Some("unsupported SQLite operation".to_string()),
    }
}

fn d2a_table_name(table_name: &str) -> &str {
    let normalized = table_name
        .rsplit('.')
        .next()
        .unwrap_or(table_name)
        .trim_matches(|character| matches!(character, '`' | '"' | '[' | ']'));
    normalized
}

// The table inventory is Native-owned in profile_egress_policy and is also
// published to Electron main. SQLite authorizer callbacks are the authority;
// main's SQL classification is only an early, fail-closed advisory.
fn renderer_profile_egress_sql_rejection(ctx: &AuthContext<'_>) -> Option<String> {
    if !PROFILE_EGRESS_SQL_ACTIVE.with(Cell::get) {
        return None;
    }
    if !matches!(ctx.database_name, None | Some("main")) {
        return Some(format!(
            "{RENDERER_PROFILE_EGRESS_ERROR}: restricted or unknown database {:?}",
            ctx.database_name
        ));
    }
    match &ctx.action {
        AuthAction::Read {
            table_name,
            column_name,
        } if crate::profile_egress_policy::is_protected_table(d2a_table_name(table_name)) =>
        {
            Some(format!(
                "{RENDERER_PROFILE_EGRESS_ERROR}: protected plaintext read from {table_name}.{column_name}"
            ))
        }
        AuthAction::Read {
            table_name,
            column_name,
        } if crate::profile_egress_policy::is_protected_column(
            d2a_table_name(table_name),
            column_name,
        ) =>
        {
            Some(format!(
                "{RENDERER_PROFILE_EGRESS_ERROR}: {table_name}.{column_name} is not published through generic SQL"
            ))
        }
        AuthAction::Delete { table_name }
        | AuthAction::Insert { table_name }
        | AuthAction::Update { table_name, .. }
            if crate::profile_egress_policy::is_protected_table(d2a_table_name(table_name))
                || d2a_table_name(table_name).eq_ignore_ascii_case("change_events")
                || d2a_table_name(table_name).eq_ignore_ascii_case("state_snapshots") =>
        {
            Some(format!(
                "{RENDERER_PROFILE_EGRESS_ERROR}: protected DML target {table_name}"
            ))
        }
        _ => None,
    }
}

fn with_profile_egress_sql<T>(operation: impl FnOnce() -> T) -> T {
    let previous = PROFILE_EGRESS_SQL_ACTIVE.with(|active| {
        let previous = active.get();
        active.set(true);
        previous
    });
    let result = operation();
    PROFILE_EGRESS_SQL_ACTIVE.with(|active| active.set(previous));
    result
}

fn with_runner_transaction_controls<T>(operation: impl FnOnce() -> T) -> T {
    let previous = RUNNER_TRANSACTION_CONTROL_ALLOWED.with(|allowed| {
        let previous = allowed.get();
        allowed.set(true);
        previous
    });
    let result = operation();
    RUNNER_TRANSACTION_CONTROL_ALLOWED.with(|allowed| allowed.set(previous));
    result
}

fn reject_stale_untrusted_transaction(conn: &Connection) -> anyhow::Result<()> {
    if conn.is_autocommit() {
        return Ok(());
    }
    let rollback = conn.execute_batch("ROLLBACK");
    match rollback {
        Ok(()) => anyhow::bail!(
            "{RENDERER_SQL_SECURITY_ERROR}: untrusted SQL connection had an open transaction; it was rolled back"
        ),
        Err(error) => anyhow::bail!(
            "{RENDERER_SQL_SECURITY_ERROR}: untrusted SQL connection had an open transaction and rollback failed: {error}"
        ),
    }
}

fn reject_untrusted_transaction_after<T>(
    conn: &Connection,
    result: anyhow::Result<T>,
) -> anyhow::Result<T> {
    if conn.is_autocommit() {
        return result;
    }
    let rollback = conn.execute_batch("ROLLBACK");
    match rollback {
        Ok(()) => anyhow::bail!(
            "{RENDERER_SQL_SECURITY_ERROR}: untrusted SQL left a transaction open; it was rolled back"
        ),
        Err(error) => anyhow::bail!(
            "{RENDERER_SQL_SECURITY_ERROR}: untrusted SQL left a transaction open and rollback failed: {error}"
        ),
    }
}

struct RendererSqlPolicyState {
    sql_length_limit: i32,
    vdbe_op_limit: i32,
    attached_limit: i32,
    attach_create_enabled: bool,
    attach_write_enabled: bool,
}

fn keep_first_cleanup_error<T>(
    first_error: &mut Option<anyhow::Error>,
    result: rusqlite::Result<T>,
) {
    if let Err(error) = result {
        if first_error.is_none() {
            *first_error = Some(error.into());
        }
    }
}

fn restore_renderer_sql_policy(
    conn: &Connection,
    state: &RendererSqlPolicyState,
    reserved_project_setting_guard_requested: bool,
) -> anyhow::Result<()> {
    let mut first_error = None;
    keep_first_cleanup_error(
        &mut first_error,
        crate::set_sqlite_progress_handler(conn, 0, None::<fn() -> bool>),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>),
    );
    if reserved_project_setting_guard_requested {
        keep_first_cleanup_error(&mut first_error, drop_reserved_project_setting_guard(conn));
    }
    keep_first_cleanup_error(
        &mut first_error,
        conn.set_db_config(
            DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE,
            state.attach_create_enabled,
        ),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.set_db_config(
            DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE,
            state.attach_write_enabled,
        ),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, state.sql_length_limit),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, state.vdbe_op_limit),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, state.attached_limit),
    );
    match first_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn sql_starts_with_keyword(sql: &str, keyword: &str) -> bool {
    let trimmed = sql.trim_start();
    let Some(prefix) = trimmed.get(..keyword.len()) else {
        return false;
    };
    prefix.eq_ignore_ascii_case(keyword)
        && trimmed[keyword.len()..]
            .chars()
            .next()
            .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
}

fn untrusted_sql_needs_reserved_project_setting_guard(sql: &str) -> bool {
    // Only an explicitly read-only first keyword skips the marker guard. A
    // leading comment, WITH clause, PRAGMA, malformed statement, or future
    // syntax stays fail-closed and receives the full untrusted policy.
    !["select", "values", "explain"]
        .iter()
        .any(|keyword| sql_starts_with_keyword(sql, keyword))
}

fn with_untrusted_sql_policy<T, F>(
    conn: &Connection,
    reserved_project_setting_guard_requested: bool,
    operation: F,
) -> anyhow::Result<T>
where
    F: FnOnce(&Connection) -> anyhow::Result<T>,
{
    let state = RendererSqlPolicyState {
        sql_length_limit: conn.limit(Limit::SQLITE_LIMIT_SQL_LENGTH)?,
        vdbe_op_limit: conn.limit(Limit::SQLITE_LIMIT_VDBE_OP)?,
        attached_limit: conn.limit(Limit::SQLITE_LIMIT_ATTACHED)?,
        attach_create_enabled: conn.db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE)?,
        attach_write_enabled: conn.db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE)?,
    };
    let denied_reason = Arc::new(Mutex::new(None::<String>));
    let budget_exhausted = Arc::new(AtomicBool::new(false));

    let denied_for_hook = Arc::clone(&denied_reason);
    let budget_for_hook = Arc::clone(&budget_exhausted);
    let setup_result = (|| -> rusqlite::Result<()> {
        if reserved_project_setting_guard_requested {
            install_reserved_project_setting_guard(conn)?;
        }
        conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, RENDERER_SQL_LENGTH_LIMIT)?;
        conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, RENDERER_VDBE_OP_LIMIT)?;
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, false)?;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            let profile_reason = renderer_profile_egress_sql_rejection(&ctx);
            if let Some(reason) = profile_reason.or_else(|| renderer_sql_rejection(ctx)) {
                if let Ok(mut denied) = denied_for_hook.lock() {
                    // A direct mutation of a protected parent may also trigger
                    // an indirect legacy `ai_audit_events` cascade.  Preserve
                    // the audit-specific reason when SQLite reports the two
                    // authorizer actions in either order: the renderer must not
                    // be able to hide an audit mutation behind the parent's
                    // protected-writer error.
                    if denied.is_none()
                        || reason == "mutation of ai_audit_events"
                            && denied.as_deref() != Some("mutation of ai_audit_events")
                    {
                        *denied = Some(reason);
                    }
                }
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))?;
        let mut callbacks = 0usize;
        crate::set_sqlite_progress_handler(
            conn,
            RENDERER_PROGRESS_INTERVAL,
            Some(move || {
                callbacks += 1;
                if callbacks >= RENDERER_MAX_PROGRESS_CALLBACKS {
                    budget_for_hook.store(true, Ordering::Relaxed);
                    true
                } else {
                    false
                }
            }),
        )?;
        Ok(())
    })();
    if let Err(error) = setup_result {
        let _ = restore_renderer_sql_policy(conn, &state, reserved_project_setting_guard_requested);
        return Err(error.into());
    }

    UNTRUSTED_SQL_ACTIVE.with(|active| active.set(true));
    let result = operation(conn);
    UNTRUSTED_SQL_ACTIVE.with(|active| active.set(false));
    PENDING_INSERT_COLUMNS.with(|columns| {
        *columns.borrow_mut() = None;
    });

    let cleanup_result =
        restore_renderer_sql_policy(conn, &state, reserved_project_setting_guard_requested);
    if let Err(error) = cleanup_result {
        return Err(anyhow::anyhow!(
            "failed to restore SQLite policy after renderer SQL: {error}"
        ));
    }

    let denied = denied_reason.lock().ok().and_then(|reason| reason.clone());
    if let Some(reason) = denied {
        let code = if reason.starts_with(RENDERER_PROFILE_EGRESS_ERROR) {
            RENDERER_PROFILE_EGRESS_ERROR
        } else if reason.starts_with(RENDERER_TYPED_PAYLOAD_ERROR) {
            RENDERER_TYPED_PAYLOAD_ERROR
        } else if reason.contains("protected") {
            PROTECTED_WRITER_SQL_ERROR
        } else {
            RENDERER_SQL_SECURITY_ERROR
        };
        return Err(anyhow::anyhow!("{code}: denied {reason}"));
    }
    if budget_exhausted.load(Ordering::Relaxed) {
        return Err(anyhow::anyhow!(
            "{RENDERER_SQL_RESOURCE_ERROR}: execution budget exceeded"
        ));
    }

    if let Err(error) = &result {
        if error.to_string().contains(PROTECTED_WRITER_SQL_ERROR) {
            return Err(anyhow::anyhow!(
                "{PROTECTED_WRITER_SQL_ERROR}: denied mutation of reserved project setting"
            ));
        }
        if matches!(
            error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == ErrorCode::AuthorizationForStatementDenied
        ) {
            return Err(anyhow::anyhow!(
                "{RENDERER_SQL_SECURITY_ERROR}: authorization denied"
            ));
        }
        if matches!(
            error.downcast_ref::<rusqlite::Error>(),
            Some(rusqlite::Error::SqliteFailure(failure, _))
                if failure.code == ErrorCode::OperationInterrupted
        ) {
            return Err(anyhow::anyhow!(
                "{RENDERER_SQL_RESOURCE_ERROR}: execution interrupted"
            ));
        }
    }
    result
}

fn prepare_untrusted_statement_context(sql: &str) {
    let insert_columns = UNTRUSTED_SQL_ACTIVE.with(|active| {
        if !active.get() {
            return None;
        }
        let lowered = sql.trim_start().to_ascii_lowercase();
        if lowered.starts_with("insert") {
            classify_insert_columns(sql)
        } else {
            None
        }
    });
    PENDING_INSERT_COLUMNS.with(|columns| {
        *columns.borrow_mut() = insert_columns;
    });
}

fn normalize_sql_identifier(token: &str) -> String {
    token
        .trim_end_matches(';')
        .rsplit('.')
        .next()
        .unwrap_or(token)
        .trim_matches(|character| matches!(character, '`' | '"' | '[' | ']'))
        .to_string()
}

/// SQLite's authorizer reports the parent DELETE before it reports a legacy
/// foreign-key cascade.  That means a protected `projects` delete could mask
/// the fact that it would also delete rows from the old `ai_audit_events`
/// ledger.  Preflight the simple DELETE form before preparing the statement so
/// the renderer receives the audit-specific denial and the operation never
/// starts.  The authorizer remains the authoritative guard for direct audit
/// mutations and less-common SQL forms.
fn renderer_indirect_ai_audit_cascade(conn: &Connection, sql: &str) -> rusqlite::Result<bool> {
    if !UNTRUSTED_SQL_ACTIVE.with(Cell::get) {
        return Ok(false);
    }

    let mut tokens = sql.split_whitespace();
    let Some(delete) = tokens.next() else {
        return Ok(false);
    };
    if !delete.eq_ignore_ascii_case("delete")
        || !tokens
            .next()
            .is_some_and(|token| token.eq_ignore_ascii_case("from"))
    {
        return Ok(false);
    }
    let Some(parent_token) = tokens.next() else {
        return Ok(false);
    };
    let parent_table = normalize_sql_identifier(parent_token);

    let mut statement = conn.prepare("PRAGMA foreign_key_list('ai_audit_events')")?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let referenced_table: String = row.get(2)?;
        let on_delete: String = row.get(6)?;
        if on_delete.eq_ignore_ascii_case("CASCADE")
            && referenced_table.eq_ignore_ascii_case(&parent_table)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

impl Database {
    fn execute_batch_tx_with_conn(
        conn: &Connection,
        statements: &[BatchStatement],
    ) -> anyhow::Result<SqlExecutionResult> {
        // BEGIN IMMEDIATE acquires the write lock up front. A plain (deferred)
        // BEGIN only takes it on the first write, so a writer on the same DB
        // file (e.g. the MCP process) could slip in between and turn a later
        // statement into SQLITE_BUSY_SNAPSHOT — which busy_timeout cannot retry.
        with_runner_transaction_controls(|| conn.execute_batch("BEGIN IMMEDIATE"))?;
        let mut last_result = SqlExecutionResult {
            rows: Vec::new(),
            statement_may_mutate: false,
        };
        let result = (|| -> anyhow::Result<_> {
            for stmt in statements {
                let execution =
                    Self::execute_with_conn_result(conn, &stmt.sql, &stmt.params, &stmt.method)?;
                last_result.statement_may_mutate |= execution.statement_may_mutate;
                last_result.rows = execution.rows;
            }
            Ok(last_result)
        })();
        match result {
            Ok(rows) => match with_runner_transaction_controls(|| conn.execute_batch("COMMIT")) {
                Ok(()) => Ok(rows),
                // A failed COMMIT (deferred FK check, busy, disk-full, ...) leaves
                // the transaction open on this shared single connection. Without
                // an explicit ROLLBACK the next caller inherits a zombie tx and
                // its writes silently ride on / get rolled back with it.
                Err(error) => {
                    let _ = with_runner_transaction_controls(|| conn.execute_batch("ROLLBACK"));
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = with_runner_transaction_controls(|| conn.execute_batch("ROLLBACK"));
                Err(error)
            }
        }
    }

    fn execute_batch_tx_impl(
        &self,
        statements: &[BatchStatement],
        origin: SqlOrigin,
    ) -> anyhow::Result<SqlExecutionResult> {
        let lock_started = Instant::now();
        let conn = self.lock_conn()?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if origin.is_untrusted() {
            match reject_stale_untrusted_transaction(&conn) {
                Ok(()) => {
                    let reserved_project_setting_guard_requested = statements.iter().any(|statement| {
                        untrusted_sql_needs_reserved_project_setting_guard(&statement.sql)
                    });
                    let result = with_untrusted_sql_policy(
                        &conn,
                        reserved_project_setting_guard_requested,
                        |conn| Self::execute_batch_tx_with_conn(conn, statements),
                    );
                    reject_untrusted_transaction_after(&conn, result)
                }
                Err(error) => Err(error),
            }
        } else {
            Self::execute_batch_tx_with_conn(&conn, statements)
        };
        let sql_ms = sql_started.elapsed().as_millis();
        if lock_wait_ms + sql_ms >= SLOW_DB_CALL_MS {
            let first_sql = statements
                .first()
                .map(|s| log_prefix(&s.sql))
                .unwrap_or_default();
            tracing::warn!(
                "database.execute_batch_tx lock_wait={}ms sql={}ms stmts={} origin={:?} first_sql={:?}",
                lock_wait_ms,
                sql_ms,
                statements.len(),
                origin,
                first_sql
            );
        }
        result
    }

    /// Execute a list of SQL statements in a single transaction.
    /// Each item is `{ sql, params, method }`. Returns last statement's rows.
    /// Trusted backend API; renderer adapters must call
    /// [`Database::execute_batch_tx_renderer`] instead.
    pub fn execute_batch_tx(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self
            .execute_batch_tx_impl(statements, SqlOrigin::TrustedDomainWriter)?
            .rows)
    }

    pub fn execute_batch_tx_with_origin(
        &self,
        origin: SqlOrigin,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self.execute_batch_tx_impl(statements, origin)?.rows)
    }

    /// Execute renderer-origin statements under the connection-local
    /// authorizer, defensive db-config, and resource limits.
    pub fn execute_batch_tx_renderer(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self
            .execute_batch_tx_renderer_with_result(statements)?
            .rows)
    }

    pub fn execute_batch_tx_renderer_with_result(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<SqlExecutionResult> {
        self.execute_batch_tx_impl(statements, SqlOrigin::Renderer)
    }

    /// Execute renderer-origin statements with the Native D2a plaintext
    /// publication guard layered onto the shared SQLite authorizer.
    pub fn execute_batch_tx_renderer_profile_egress(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self
            .execute_batch_tx_renderer_profile_egress_with_result(statements)?
            .rows)
    }

    pub fn execute_batch_tx_renderer_profile_egress_with_result(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<SqlExecutionResult> {
        with_profile_egress_sql(|| self.execute_batch_tx_impl(statements, SqlOrigin::Renderer))
    }

    pub fn execute_batch_tx_untrusted(
        &self,
        origin: SqlOrigin,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        anyhow::ensure!(
            origin.is_untrusted(),
            "execute_batch_tx_untrusted requires an untrusted SqlOrigin"
        );
        Ok(self.execute_batch_tx_impl(statements, origin)?.rows)
    }

    pub fn execute_with_conn(
        conn: &Connection,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(Self::execute_with_conn_result(conn, sql, params, method)?.rows)
    }

    fn execute_with_conn_result(
        conn: &Connection,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<SqlExecutionResult> {
        prepare_untrusted_statement_context(sql);
        if renderer_indirect_ai_audit_cascade(conn, sql)? {
            return Err(anyhow::anyhow!(
                "{RENDERER_SQL_SECURITY_ERROR}: denied mutation of ai_audit_events"
            ));
        }
        let mut stmt = conn.prepare(sql)?;
        let statement_may_mutate = !stmt.readonly();
        // SQLite itself is the parser for DML result shape. Checking
        // `readonly` plus `column_count` rejects every DML `RETURNING` form
        // (including CTE variants) before execution without a pseudo parser.
        if PROFILE_EGRESS_SQL_ACTIVE.with(Cell::get)
            && statement_may_mutate
            && stmt.column_count() > 0
        {
            anyhow::bail!(
                "{RENDERER_PROFILE_EGRESS_ERROR}: DML result plaintext is not published"
            );
        }
        let native_params: Vec<Box<dyn rusqlite::types::ToSql>> = params
            .iter()
            .map(|v| -> Box<dyn rusqlite::types::ToSql> {
                match v {
                    Value::Null => Box::new(Option::<String>::None),
                    Value::Bool(b) => Box::new(*b),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            Box::new(i)
                        } else {
                            Box::new(n.as_f64().unwrap_or(0.0))
                        }
                    }
                    Value::String(s) => Box::new(s.clone()),
                    _ => Box::new(v.to_string()),
                }
            })
            .collect();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            native_params.iter().map(|p| p.as_ref()).collect();

        if method == "run" {
            stmt.execute(params_from_iter(param_refs.iter()))?;
            return Ok(SqlExecutionResult {
                rows: vec![],
                statement_may_mutate,
            });
        }

        let column_names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt.query_map(params_from_iter(param_refs.iter()), |row| {
            let mut map = serde_json::Map::new();
            for (i, col_name) in column_names.iter().enumerate() {
                let val: Value = match row.get_ref(i) {
                    Ok(rusqlite::types::ValueRef::Null) => Value::Null,
                    Ok(rusqlite::types::ValueRef::Integer(n)) => Value::Number(n.into()),
                    Ok(rusqlite::types::ValueRef::Real(f)) => {
                        Value::Number(serde_json::Number::from_f64(f).unwrap_or_else(|| 0.into()))
                    }
                    Ok(rusqlite::types::ValueRef::Text(s)) => {
                        Value::String(String::from_utf8_lossy(s).to_string())
                    }
                    Ok(rusqlite::types::ValueRef::Blob(b)) => {
                        Value::String(format!("[blob {} bytes]", b.len()))
                    }
                    Err(_) => Value::Null,
                };
                // The proxy maps rows positionally on the JS side
                // (`Object.values(row)` in src/db/client.ts) over this
                // insertion-ordered map (serde_json `preserve_order`). A JOIN
                // that yields two columns with the same name would collide on
                // insert, dropping a value and shifting every later column. Keep
                // arity/order intact by suffixing duplicate keys; the key text is
                // irrelevant to the positional mapping.
                if map.contains_key(col_name) {
                    map.insert(format!("{col_name}\u{0}{i}"), val);
                } else {
                    map.insert(col_name.clone(), val);
                }
            }
            Ok(map)
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        if method == "get" {
            return Ok(SqlExecutionResult {
                rows: result.into_iter().take(1).collect(),
                statement_may_mutate,
            });
        }
        Ok(SqlExecutionResult {
            rows: result,
            statement_may_mutate,
        })
    }

    pub fn execute(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self
            .execute_impl(sql, params, method, SqlOrigin::TrustedDomainWriter)?
            .rows)
    }

    /// Execute one renderer-origin statement under the restricted policy.
    pub fn execute_renderer(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self.execute_renderer_with_result(sql, params, method)?.rows)
    }

    pub fn execute_renderer_with_result(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<SqlExecutionResult> {
        self.execute_impl(sql, params, method, SqlOrigin::Renderer)
    }

    /// Execute one renderer-origin statement with the Native D2a plaintext
    /// publication guard layered onto the shared SQLite authorizer.
    pub fn execute_renderer_profile_egress(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self
            .execute_renderer_profile_egress_with_result(sql, params, method)?
            .rows)
    }

    pub fn execute_renderer_profile_egress_with_result(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<SqlExecutionResult> {
        with_profile_egress_sql(|| self.execute_impl(sql, params, method, SqlOrigin::Renderer))
    }

    pub fn execute_with_origin(
        &self,
        origin: SqlOrigin,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        Ok(self.execute_impl(sql, params, method, origin)?.rows)
    }

    pub fn execute_untrusted(
        &self,
        origin: SqlOrigin,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        anyhow::ensure!(
            origin.is_untrusted(),
            "execute_untrusted requires an untrusted SqlOrigin"
        );
        Ok(self.execute_impl(sql, params, method, origin)?.rows)
    }

    fn execute_impl(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
        origin: SqlOrigin,
    ) -> anyhow::Result<SqlExecutionResult> {
        let lock_started = Instant::now();
        let conn = self.lock_conn()?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if origin.is_untrusted() {
            match reject_stale_untrusted_transaction(&conn) {
                Ok(()) => {
                    let reserved_project_setting_guard_requested =
                        untrusted_sql_needs_reserved_project_setting_guard(sql);
                    let result = with_untrusted_sql_policy(
                        &conn,
                        reserved_project_setting_guard_requested,
                        |conn| Self::execute_with_conn_result(conn, sql, params, method),
                    );
                    reject_untrusted_transaction_after(&conn, result)
                }
                Err(error) => Err(error),
            }
        } else {
            Self::execute_with_conn_result(&conn, sql, params, method)
        };
        let sql_ms = sql_started.elapsed().as_millis();
        if lock_wait_ms + sql_ms >= SLOW_DB_CALL_MS {
            tracing::warn!(
                "database.execute lock_wait={}ms sql={}ms method={} origin={:?} sql={:?}",
                lock_wait_ms,
                sql_ms,
                method,
                origin,
                log_prefix(sql)
            );
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::foreshadow;
    use super::super::narrative_extraction::maintenance_runtime::SCAN_IMPORT_STATE_KEY;
    use super::*;
    use std::collections::BTreeSet;
    use std::path::PathBuf;

    fn test_db() -> Database {
        Database::new(std::path::Path::new(":memory:")).expect("open in-memory database")
    }

    fn temp_sqlite_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "grimodex-renderer-sql-{label}-{}.db",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn renderer_sql_allows_normal_crud_but_not_schema_changes() {
        let db = test_db();
        db.execute(
            "CREATE TABLE renderer_crud (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted schema setup");

        db.execute_renderer(
            "INSERT INTO renderer_crud (id, value) VALUES (?1, ?2)",
            &[Value::from(1), Value::from("before")],
            "run",
        )
        .expect("renderer insert");
        db.execute_renderer(
            "UPDATE renderer_crud SET value = ?1 WHERE id = ?2",
            &[Value::from("after"), Value::from(1)],
            "run",
        )
        .expect("renderer update");
        let rows = db
            .execute_renderer(
                "SELECT value FROM renderer_crud WHERE id = ?1",
                &[Value::from(1)],
                "get",
            )
            .expect("renderer select");
        assert_eq!(rows[0]["value"], Value::from("after"));
        db.execute_renderer(
            "DELETE FROM renderer_crud WHERE id = ?1",
            &[Value::from(1)],
            "run",
        )
        .expect("renderer delete");

        let error = db
            .execute_renderer("CREATE TABLE blocked (id INTEGER)", &[], "run")
            .expect_err("renderer schema changes must be rejected");
        assert!(
            error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied schema operation"),
            "unexpected error: {error}"
        );
        db.execute("CREATE TABLE trusted (id INTEGER)", &[], "run")
            .expect("trusted backend schema operation remains available");
    }

    #[test]
    fn renderer_sql_cannot_control_the_runner_transaction_or_leave_one_open() {
        let db = test_db();
        db.execute(
            "CREATE TABLE renderer_transaction_guard (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted schema setup");
        db.execute(
            "INSERT INTO renderer_transaction_guard (id, value) VALUES (1, 0)",
            &[],
            "run",
        )
        .expect("trusted seed");

        for sql in [
            "BEGIN",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT renderer_savepoint",
            "RELEASE renderer_savepoint",
        ] {
            let error = db
                .execute_renderer(sql, &[], "run")
                .expect_err("renderer transaction control must be rejected");
            assert!(
                error.to_string().contains("transaction control"),
                "unexpected {sql} error: {error}"
            );
            db.with_conn(|conn| {
                anyhow::ensure!(
                    conn.is_autocommit(),
                    "renderer control left the shared connection in a transaction: {sql}"
                );
                Ok(())
            })
            .expect("inspect autocommit state");
        }

        db.with_conn(|conn| {
            conn.execute_batch("BEGIN")?;
            Ok(())
        })
        .expect("trusted fixture transaction");
        let error = db
            .execute_renderer("SELECT 1", &[], "get")
            .expect_err("an inherited transaction must not cross the renderer boundary");
        assert!(error.to_string().contains("open transaction"));
        db.with_conn(|conn| {
            anyhow::ensure!(conn.is_autocommit(), "stale transaction was not cleaned up");
            Ok(())
        })
        .expect("stale transaction cleanup");

        let error = db
            .execute_batch_tx_renderer(&[
                BatchStatement {
                    sql: "UPDATE renderer_transaction_guard SET value = 1 WHERE id = 1".into(),
                    params: vec![],
                    method: "run".into(),
                },
                BatchStatement {
                    sql: "COMMIT".into(),
                    params: vec![],
                    method: "run".into(),
                },
            ])
            .expect_err("payload COMMIT must not escape the runner rollback");
        assert!(error.to_string().contains("transaction control"));
        let rows = db
            .execute(
                "SELECT value FROM renderer_transaction_guard WHERE id = 1",
                &[],
                "get",
            )
            .expect("inspect rolled back value");
        assert_eq!(rows[0]["value"], Value::from(0));
        db.with_conn(|conn| {
            anyhow::ensure!(conn.is_autocommit(), "failed batch left a transaction open");
            Ok(())
        })
        .expect("failed batch cleanup");
    }

    #[test]
    fn profile_egress_protects_plaintext_replicas_in_the_idempotency_ledger() {
        let db = crate::test_support::current_schema_memory().expect("current schema fixture");
        let project_id = "idempotency-protected-project";
        let foreshadow_id = "idempotency-protected-foreshadow";
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, ?)",
            &[
                Value::String(project_id.to_string()),
                Value::String("Protected ledger test".to_string()),
            ],
            "run",
        )
        .expect("seed project");
        db.execute(
            "INSERT INTO foreshadows
                (id, project_id, title, notes, payoff_confirmed, abandoned, secret,
                 created_at, updated_at)
             VALUES (?, ?, ?, ?, 0, 0, 1, ?, ?)",
            &[
                Value::String(foreshadow_id.to_string()),
                Value::String(project_id.to_string()),
                Value::String("SECRET_FORESHADOW_TITLE".to_string()),
                Value::String("SECRET_FORESHADOW_NOTES".to_string()),
                Value::Number(1_i64.into()),
                Value::Number(1_i64.into()),
            ],
            "run",
        )
        .expect("seed foreshadow");

        // The no-op typed update intentionally stores the complete historical
        // row in the non-create idempotency receipt, reproducing the legacy
        // plaintext replica that D2a must cover independently of foreshadows.
        let patch: foreshadow::ForeshadowPatch = serde_json::from_value(serde_json::json!({
            "requestId": "idempotency-protected-request",
            "sessionId": "idempotency-protected-session",
            "eventUid": "idempotency-protected-event",
            "origin": "human",
            "projectId": project_id,
            "baseVersion": 0
        }))
        .expect("typed no-op update payload");
        let response = foreshadow::update(&db, foreshadow_id.to_string(), patch)
            .expect("typed update");
        assert_eq!(response["notes"], Value::String("SECRET_FORESHADOW_NOTES".to_string()));

        let ledger = db
            .execute(
                "SELECT tombstone_json FROM idempotency_requests
                  WHERE domain = 'foreshadow_update'
                    AND request_id = 'idempotency-protected-request'",
                &[],
                "get",
            )
            .expect("read ledger through trusted Native path");
        assert!(ledger[0]["tombstone_json"]
            .as_str()
            .expect("ledger response")
            .contains("SECRET_FORESHADOW_NOTES"));

        let error = db
            .execute_renderer_profile_egress(
                "SELECT json_extract(tombstone_json, '$.notes')
                   FROM idempotency_requests
                  WHERE domain = 'foreshadow_update'",
                &[],
                "all",
            )
            .expect_err("D2a must deny the replicated plaintext read");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "unexpected ledger read error: {error}"
        );

        for sql in [
            "UPDATE idempotency_requests SET tombstone_json = '{}'",
            "DELETE FROM idempotency_requests",
            "INSERT INTO idempotency_requests
                (domain, request_id, project_id, payload_hash, tombstone_json)
             VALUES ('tamper', 'tamper', 'idempotency-protected-project', 'hash', '{}')",
        ] {
            let error = db
                .execute_renderer(sql, &[], "run")
                .expect_err("renderer must not mutate the Native idempotency ledger");
            assert!(
                error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                "unexpected ledger mutation error for {sql}: {error}"
            );
        }
    }

    #[test]
    fn profile_egress_rejects_restricted_reads_and_dml_result_plaintext() {
        let db = test_db();
        db.execute(
            "CREATE TABLE projects (id INTEGER PRIMARY KEY, value TEXT)",
            &[],
            "run",
        )
        .expect("trusted local schema setup");
        db.execute(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
            &[],
            "run",
        )
        .expect("trusted settings schema setup");
        db.execute("CREATE TABLE messages (content TEXT NOT NULL)", &[], "run")
            .expect("trusted restricted schema setup");
        db.execute(
            "CREATE TABLE chat_summaries (id TEXT PRIMARY KEY, summary TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted chat summary schema setup");
        db.execute(
            "CREATE TABLE chat_message_chunks (message_id TEXT PRIMARY KEY, text TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted chat chunk schema setup");
        db.execute(
            "CREATE TABLE generation_logs (id TEXT PRIMARY KEY, prompt_full TEXT)",
            &[],
            "run",
        )
        .expect("trusted generation log schema setup");
        db.execute(
            "CREATE TABLE ab_comparisons (id TEXT PRIMARY KEY, response_a TEXT, response_b TEXT)",
            &[],
            "run",
        )
        .expect("trusted A/B comparison schema setup");
        db.execute(
            "CREATE TABLE ab_comparison_runs (id TEXT PRIMARY KEY, slots TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted A/B run schema setup");
        db.execute("CREATE TABLE d2a_unknown (value TEXT)", &[], "run")
            .expect("trusted unknown schema setup");
        db.execute(
            "CREATE TABLE change_events (sequence INTEGER, domain TEXT, payload TEXT)",
            &[],
            "run",
        )
        .expect("trusted change event schema setup");
        db.execute(
            "CREATE TEMP TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
            &[],
            "run",
        )
        .expect("trusted temporary settings schema setup");
        db.execute(
            "INSERT INTO messages (content) VALUES ('private')",
            &[],
            "run",
        )
        .expect("trusted restricted seed");
        db.execute(
            "INSERT INTO change_events (sequence, domain, payload) VALUES (1, 'editor', '{\"text\":\"private\"}')",
            &[],
            "run",
        )
        .expect("trusted change event seed");

        let rows = db
            .execute_renderer_profile_egress("SELECT id FROM projects", &[], "all")
            .expect("ordinary workspace reads remain available");
        assert!(rows.is_empty());
        let rows = db
            .execute_renderer_profile_egress(
                "SELECT domain, sequence FROM change_events",
                &[],
                "all",
            )
            .expect("change event metadata read remains available");
        assert_eq!(rows.len(), 1);

        let error = db
            .execute_renderer_profile_egress("SELECT content FROM messages", &[], "all")
            .expect_err("D2a must not publish restricted reads");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "unexpected error: {error}"
        );

        let error = db
            .execute_renderer_profile_egress("SELECT value FROM temp.app_settings", &[], "all")
            .expect_err("D2a must not publish temporary or attached database reads");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "unexpected error: {error}"
        );

        for sql in [
            "SELECT content FROM \"messages\"",
            "SELECT summary FROM chat_summaries",
            "SELECT text FROM chat_message_chunks",
            "SELECT prompt_full FROM generation_logs",
            "SELECT response_a, response_b FROM ab_comparisons",
            "SELECT slots FROM ab_comparison_runs",
            "WITH source AS (SELECT content FROM messages) SELECT content FROM source",
            "SELECT value FROM (SELECT content AS value FROM messages)",
            "SELECT value FROM app_settings WHERE value IN (SELECT content FROM messages)",
            "UPDATE app_settings SET value = (SELECT content FROM messages)",
            "WITH source AS (SELECT content FROM messages) INSERT INTO app_settings (key, value) SELECT 'leak', value FROM source",
            "SELECT payload FROM change_events",
            "SELECT * FROM change_events",
            "INSERT INTO change_events (sequence, domain, payload) VALUES (2, 'editor', 'private')",
        ] {
            let error = db
                .execute_renderer_profile_egress(sql, &[], "all")
                .expect_err("D2a must reject protected plaintext access");
            assert!(
                error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
                "unexpected error for {sql}: {error}"
            );
        }

        // There is intentionally no workspace-table allowlist here. Main's
        // issued caller binding and route ledger decide whether a generic
        // renderer query is trusted; this layer closes known plaintext
        // surfaces and dangerous SQLite operations.
        db.execute_renderer_profile_egress(
            "INSERT INTO d2a_unknown (value) VALUES ('local')",
            &[],
            "run",
        )
        .expect("ordinary workspace DML remains available");

        let error = db
            .execute_renderer_profile_egress(
                "INSERT INTO d2a_unknown (value) VALUES ('local') RETURNING value",
                &[],
                "all",
            )
            .expect_err("D2a must not publish DML RETURNING rows");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "unexpected error: {error}"
        );

        let error = db
            .execute_renderer_profile_egress(
                "INSERT INTO app_settings (key, value) SELECT 'leak', content FROM messages",
                &[],
                "run",
            )
            .expect_err("D2a must not read restricted sources during DML");
        assert!(
            error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn profile_egress_allows_non_plaintext_local_dml() {
        let db = test_db();
        db.execute(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)",
            &[],
            "run",
        )
        .expect("trusted local schema setup");

        db.execute_renderer_profile_egress(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            &[Value::from("local"), Value::from("setting")],
            "run",
        )
        .expect("non-model local DML remains available");
    }

    #[test]
    fn sqlite_prepared_statement_classifies_comments_and_ctes() {
        let db = test_db();
        db.execute(
            "CREATE TABLE renderer_statement_kind (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted local schema setup");
        db.execute(
            "INSERT INTO renderer_statement_kind (id, value) VALUES (1, 1)",
            &[],
            "run",
        )
        .expect("trusted local seed");

        for sql in [
            "SELECT value FROM renderer_statement_kind WHERE id = 1",
            "/* leading comment */ SELECT value FROM renderer_statement_kind WHERE id = 1",
            "-- leading comment\nSELECT value FROM renderer_statement_kind WHERE id = 1",
            "WITH source AS (SELECT value FROM renderer_statement_kind) SELECT value FROM source",
        ] {
            let result = db
                .execute_renderer_profile_egress_with_result(sql, &[], "all")
                .expect("read-only statement should execute");
            assert!(
                !result.statement_may_mutate,
                "SQLite marked a read-only statement as mutable: {sql}"
            );
            assert_eq!(result.rows.len(), 1, "unexpected rows for {sql}");
        }

        let result = db
            .execute_renderer_profile_egress_with_result(
                "WITH next(value) AS (SELECT 2)
                 UPDATE renderer_statement_kind
                    SET value = (SELECT value FROM next)
                  WHERE id = 1",
                &[],
                "all",
            )
            .expect("CTE update should execute");
        assert!(result.statement_may_mutate);
        assert!(result.rows.is_empty());

        let batch = db
            .execute_batch_tx_renderer_profile_egress_with_result(&[
                BatchStatement {
                    sql: "WITH source AS (SELECT value FROM renderer_statement_kind)
                           SELECT value FROM source"
                        .into(),
                    params: vec![],
                    method: "all".into(),
                },
            ])
            .expect("read-only CTE batch should execute");
        assert!(!batch.statement_may_mutate);
        assert_eq!(batch.rows.len(), 1);
    }

    #[test]
    fn profile_egress_protects_every_native_inventory_table_in_a_real_database() {
        let db = test_db();
        for table in crate::profile_egress_policy::PROFILE_EGRESS_PROTECTED_TABLES {
            db.execute(&format!("CREATE TABLE {table} (value TEXT)"), &[], "run")
                .unwrap_or_else(|error| panic!("create protected table {table}: {error}"));
        }

        for table in crate::profile_egress_policy::PROFILE_EGRESS_PROTECTED_TABLES {
            let error = db
                .execute_renderer_profile_egress(&format!("SELECT * FROM {table}"), &[], "all")
                .expect_err("every inventory table must be denied through generic SQL");
            assert!(
                error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
                "unexpected error for protected table {table}: {error}"
            );
        }
    }

    #[test]
    fn profile_egress_protects_denied_route_tables_and_fts_shadow_content_in_migrated_db() {
        let db = test_db();
        db.migrate().expect("migrate current schema");

        let existing_tables = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type IN ('table', 'virtual') AND name NOT LIKE 'sqlite_%'",
                )?;
                let names = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<BTreeSet<_>>>()?;
                Ok(names)
            })
            .expect("read migrated schema");

        let protected_tables = [
            "project_snapshot_tree_nodes",
            "project_snapshot_codex_entries",
            "project_snapshot_snippets",
            "project_snapshot_aux",
            "content_versions",
            "trash_items",
            "foreshadows",
            "foreshadow_setups",
            "foreshadow_payoffs",
            "foreshadow_setup_payoff_links",
            "foreshadow_codex_links",
            "plot_threads",
            "plot_thread_scene_links",
            "plot_thread_branches",
            "lint_ignored_diagnostics",
            "lint_term_dictionary",
            "narrative_consumer_freshness",
            "narrative_maintenance_finding_observations",
            "narrative_maintenance_finding_lifecycle",
            "narrative_maintenance_attention",
            "narrative_proposal_applications",
            "narrative_extraction_stage_model_bindings",
            "narrative_extraction_stage_receipts",
        ];
        for table in protected_tables {
            assert!(
                existing_tables.contains(table),
                "migrated schema is missing sentinel table {table}"
            );
            let error = db
                .execute_renderer_profile_egress(
                    &format!("SELECT * FROM \"{table}\" LIMIT 0"),
                    &[],
                    "all",
                )
                .expect_err("protected route table read must be denied");
            assert!(
                error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
                "unexpected read error for {table}: {error}"
            );

            let error = db
                .execute_renderer_profile_egress(
                    &format!("DELETE FROM \"{table}\" WHERE 0"),
                    &[],
                    "run",
                )
                .expect_err("protected route table DML must be denied");
            assert!(
                error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
                "unexpected DML error for {table}: {error}"
            );
        }

        let fts_shadow_tables = [
            "chat_messages_fts_config",
            "chat_messages_fts_data",
            "chat_messages_fts_docsize",
            "chat_messages_fts_idx",
            "chat_messages_fts_en_config",
            "chat_messages_fts_en_content",
            "chat_messages_fts_en_data",
            "chat_messages_fts_en_docsize",
            "chat_messages_fts_en_idx",
            "post_effect_annotations_fts_config",
            "post_effect_annotations_fts_data",
            "post_effect_annotations_fts_docsize",
            "post_effect_annotations_fts_idx",
            "post_effect_annotations_fts_en_config",
            "post_effect_annotations_fts_en_content",
            "post_effect_annotations_fts_en_data",
            "post_effect_annotations_fts_en_docsize",
            "post_effect_annotations_fts_en_idx",
        ];
        for table in fts_shadow_tables {
            assert!(
                existing_tables.contains(table),
                "migrated schema is missing sentinel table {table}"
            );
            let error = db
                .execute_renderer_profile_egress(&format!("SELECT * FROM \"{table}\""), &[], "all")
                .expect_err("protected route table read must be denied");
            assert!(
                error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR),
                "unexpected read error for {table}: {error}"
            );
        }

        db.execute_renderer_profile_egress(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
            &[Value::from("d2a-test"), Value::from("local")],
            "run",
        )
        .expect("ordinary app settings insert remains available");
        let settings = db
            .execute_renderer_profile_egress(
                "SELECT value FROM app_settings WHERE key = ?1",
                &[Value::from("d2a-test")],
                "all",
            )
            .expect("ordinary app settings read remains available");
        assert_eq!(settings[0]["value"], Value::from("local"));
        db.execute_renderer_profile_egress(
            "UPDATE app_settings SET value = ?1 WHERE key = ?2",
            &[Value::from("updated"), Value::from("d2a-test")],
            "run",
        )
        .expect("ordinary app settings update remains available");
        db.execute_renderer_profile_egress(
            "DELETE FROM app_settings WHERE key = ?1",
            &[Value::from("d2a-test")],
            "run",
        )
        .expect("ordinary app settings delete remains available");
        db.execute_renderer_profile_egress(
            "SELECT id, title FROM projects ORDER BY id",
            &[],
            "all",
        )
        .expect("ordinary project read remains available");
    }

    #[test]
    fn profile_egress_denies_snapshot_payload_but_keeps_metadata_readable() {
        let db = test_db();
        db.execute(
            "CREATE TABLE state_snapshots (
                id INTEGER PRIMARY KEY,
                domain TEXT NOT NULL,
                anchor_sequence INTEGER NOT NULL,
                payload TEXT NOT NULL
            )",
            &[],
            "run",
        )
        .expect("trusted snapshot schema setup");
        db.execute(
            "INSERT INTO state_snapshots (id, domain, anchor_sequence, payload)
             VALUES (1, 'editor', 1, '{\"text\":\"private\"}')",
            &[],
            "run",
        )
        .expect("trusted snapshot seed");
        let rows = db
            .execute_renderer_profile_egress(
                "SELECT domain, anchor_sequence FROM state_snapshots",
                &[],
                "all",
            )
            .expect("snapshot metadata remains readable");
        assert_eq!(rows.len(), 1);
        let error = db
            .execute_renderer_profile_egress("SELECT payload FROM state_snapshots", &[], "all")
            .expect_err("snapshot payload must not be published");
        assert!(error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR));
        let error = db
            .execute_renderer_profile_egress(
                "INSERT INTO state_snapshots (id, domain, anchor_sequence, payload)
                 VALUES (2, 'editor', 2, 'private')",
                &[],
                "run",
            )
            .expect_err("snapshot payload writes stay Native-owned");
        assert!(error.to_string().contains(RENDERER_PROFILE_EGRESS_ERROR));
    }

    #[test]
    fn renderer_sql_rejects_attach_vacuum_into_and_file_functions() {
        let db = test_db();
        let attach_path = temp_sqlite_path("attach");
        let vacuum_path = temp_sqlite_path("vacuum");

        let attach_error = db
            .execute_renderer(
                "ATTACH DATABASE ?1 AS audit",
                &[Value::String(attach_path.to_string_lossy().into_owned())],
                "run",
            )
            .expect_err("renderer ATTACH must be rejected");
        assert!(
            attach_error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied ATTACH or VACUUM"),
            "unexpected error: {attach_error}"
        );
        assert!(!attach_path.exists(), "ATTACH must not create a file");

        let vacuum_error = db
            .execute_renderer(
                "VACUUM INTO ?1",
                &[Value::String(vacuum_path.to_string_lossy().into_owned())],
                "run",
            )
            .expect_err("renderer VACUUM INTO must be rejected");
        assert!(
            vacuum_error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied ATTACH or VACUUM"),
            "unexpected error: {vacuum_error}"
        );
        assert!(!vacuum_path.exists(), "VACUUM INTO must not create a file");

        let function_error = db
            .execute_renderer(
                "SELECT load_extension(?1)",
                &[Value::from("not-a-real-extension")],
                "get",
            )
            .expect_err("extension loading must be rejected by policy");
        assert!(
            function_error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied function load_extension"),
            "unexpected error: {function_error}"
        );

        let _ = std::fs::remove_file(attach_path);
        let _ = std::fs::remove_file(vacuum_path);
    }

    #[test]
    fn renderer_sql_can_read_but_cannot_mutate_ai_audit_events() {
        let db = test_db();
        db.execute(
            "CREATE TABLE ai_audit_events (
                id INTEGER PRIMARY KEY,
                project_id TEXT NOT NULL,
                payload TEXT NOT NULL
             )",
            &[],
            "run",
        )
        .expect("trusted audit schema setup");
        db.execute(
            "INSERT INTO ai_audit_events (id, project_id, payload)
             VALUES (1, 'project-1', '{}')",
            &[],
            "run",
        )
        .expect("trusted audit append");

        let rows = db
            .execute_renderer(
                "SELECT payload FROM ai_audit_events WHERE project_id = ?1",
                &[Value::from("project-1")],
                "all",
            )
            .expect("renderer audit read remains available");
        assert_eq!(rows.len(), 1);

        for sql in [
            "INSERT INTO ai_audit_events (id, project_id, payload) VALUES (2, 'project-1', '{}')",
            "UPDATE ai_audit_events SET payload = '{\"tampered\":true}' WHERE id = 1",
            "DELETE FROM ai_audit_events WHERE id = 1",
        ] {
            let error = db
                .execute_renderer(sql, &[], "run")
                .expect_err("renderer audit mutation must be rejected");
            assert!(
                error
                    .to_string()
                    .contains("RENDERER_SQL_SECURITY: denied mutation of ai_audit_events"),
                "unexpected error: {error}"
            );
        }
    }

    #[test]
    fn renderer_rejects_indirect_legacy_ai_audit_cascade() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.pragma_update(None, "foreign_keys", true)?;
            conn.execute_batch(
                "CREATE TABLE projects (id TEXT PRIMARY KEY);
                 CREATE TABLE ai_audit_events (
                    id INTEGER PRIMARY KEY,
                    project_id TEXT NOT NULL
                      REFERENCES projects(id) ON DELETE CASCADE,
                    payload TEXT NOT NULL
                 );
                 INSERT INTO projects (id) VALUES ('project-1');
                 INSERT INTO ai_audit_events (id, project_id, payload)
                 VALUES (1, 'project-1', '{}');",
            )?;
            Ok(())
        })
        .expect("create legacy audit cascade fixture");

        let error = db
            .execute_renderer(
                "DELETE FROM projects WHERE id = ?1",
                &[Value::from("project-1")],
                "run",
            )
            .expect_err("renderer must reject an indirect audit cascade");
        assert!(
            error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied mutation of ai_audit_events"),
            "unexpected error: {error}"
        );

        for table in ["projects", "ai_audit_events"] {
            let rows = db
                .execute(&format!("SELECT count(*) AS n FROM {table}"), &[], "get")
                .expect("read fixture after rejected cascade");
            assert_eq!(rows[0]["n"], Value::from(1));
        }
    }

    #[test]
    fn renderer_batch_audit_mutation_is_rejected_and_rolls_back_prior_writes() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TABLE renderer_batch_guard (id INTEGER PRIMARY KEY);
                 CREATE TABLE ai_audit_events (
                id INTEGER PRIMARY KEY,
                project_id TEXT NOT NULL,
                payload TEXT NOT NULL
             );
             INSERT INTO ai_audit_events (id, project_id, payload)
             VALUES (1, 'project-1', '{}');",
            )?;
            Ok(())
        })
        .expect("trusted schema setup");

        let error = db
            .execute_batch_tx_renderer(&[
                BatchStatement {
                    sql: "INSERT INTO renderer_batch_guard (id) VALUES (1)".into(),
                    params: vec![],
                    method: "run".into(),
                },
                BatchStatement {
                    sql: "UPDATE ai_audit_events SET payload = '{}' WHERE id = 1".into(),
                    params: vec![],
                    method: "run".into(),
                },
            ])
            .expect_err("audit mutation must reject the full renderer batch");
        assert!(error
            .to_string()
            .contains("RENDERER_SQL_SECURITY: denied mutation of ai_audit_events"));
        let rows = db
            .execute("SELECT count(*) AS n FROM renderer_batch_guard", &[], "get")
            .expect("query rollback result");
        assert_eq!(rows[0]["n"], Value::from(0));
    }

    #[test]
    fn typed_project_delete_cascades_protected_rows_and_retains_ai_audit_events() {
        let db = test_db();
        db.migrate().expect("migrate database");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed project");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json,
                     spec_digest, status, created_at)
                 VALUES ('run-delete', 'project-1', 'surface', '{}', '{}',
                         'digest', 'completed', datetime('now'));
                 INSERT INTO narrative_extraction_tasks
                    (id, run_id, task_kind, status, input_json, created_at)
                 VALUES ('task-delete', 'run-delete', 'task', 'completed', '{}', datetime('now'));
                 INSERT INTO narrative_extraction_attempts
                    (id, task_id, attempt_number, status, started_at)
                 VALUES ('attempt-delete', 'task-delete', 1, 'completed', datetime('now'));
                 INSERT INTO narrative_extraction_task_edges
                    (id, run_id, from_task_id, to_task_id, edge_kind, created_at)
                 VALUES ('edge-delete', 'run-delete', 'task-delete', 'task-delete', 'depends_on', datetime('now'));
                 INSERT INTO narrative_extraction_artifacts
                    (id, run_id, task_id, attempt_id, artifact_kind, payload_json, created_at)
                 VALUES ('artifact-delete', 'run-delete', 'task-delete', 'attempt-delete', 'test', '{}', datetime('now'));
                 INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, status, summary_json, created_at, updated_at)
                 VALUES ('set-delete', 'run-delete', 'project-1', 'test', 'draft', '{}', datetime('now'), datetime('now'));
                 INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, payload_json, created_at, updated_at)
                 VALUES ('proposal-delete', 'set-delete', 'key-delete', 'test', '{}', datetime('now'), datetime('now'));
                 INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind, created_at, created_by)
                 VALUES ('revision-delete', 'proposal-delete', 1, '{}', 'legacy-unbound', datetime('now'), 'test');
                 UPDATE narrative_proposals
                    SET current_revision_id = 'revision-delete'
                  WHERE id = 'proposal-delete';
                 INSERT INTO narrative_revision_source_basis
                    (revision_id, ordinal, source_kind, source_key, revision_token)
                 VALUES ('revision-delete', 0, 'snapshot-document', 'source-delete', 'revision-1');
                 INSERT INTO narrative_proposal_decisions
                    (id, proposal_id, revision_id, decision, decision_json, created_at, created_by)
                 VALUES ('decision-delete', 'proposal-delete', 'revision-delete', 'deferred', '{}', datetime('now'), 'test');
                 INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest, status, created_at)
                 VALUES ('commit-delete', 'project-1', 'run-delete', 'set-delete', 'request-delete', 'plan-delete', 'prepared', datetime('now'));
                 INSERT INTO narrative_apply_operations
                    (id, commit_id, operation_index, operation_kind, payload_json, status, created_at)
                 VALUES ('operation-delete', 'commit-delete', 0, 'test', '{}', 'prepared', datetime('now'));
                 INSERT INTO narrative_commit_journals
                    (id, commit_id, project_id, after_json, created_at)
                 VALUES ('journal-delete', 'commit-delete', 'project-1', '{}', datetime('now'));
                 INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind, updated_at)
                 VALUES ('project-1', 'codex-entry', 'entry-delete', '/summary', 'ai', datetime('now'));",
            )?;
            Ok(())
        })
        .expect("seed un-applied narrative graph");
        db.execute(
            "INSERT INTO lint_term_dictionary
             (id, project_id, preferred, variants, created_at, updated_at)
             VALUES ('term-1', 'project-1', 'preferred', '[]', 1, 1)",
            &[],
            "run",
        )
        .expect("seed project-scoped legacy cleanup row");
        db.execute(
            "INSERT INTO ai_audit_events
             (scope_id, project_id, sequence, event_id, execution_id, operation_id,
              path_id, event_type, timestamp, recorded_at, payload, payload_sha256,
              prev_hash, hash)
             VALUES ('project:project-1', 'project-1', 1, 'event-1', 'execution-1', 'operation-1',
                     'chat.direct', 'execution.started', 1, 1, '{}', 'payload-hash',
                     'prev-hash', 'hash')",
            &[],
            "run",
        )
        .expect("trusted audit append fixture");

        let renderer_error = db
            .execute_renderer(
                "DELETE FROM projects WHERE id = ?1",
                &[Value::from("project-1")],
                "run",
            )
            .expect_err("renderer project delete must not bypass protected cascades");
        assert!(renderer_error
            .to_string()
            .contains(PROTECTED_WRITER_SQL_ERROR));

        crate::domain_writes::project_delete(
            &db,
            crate::domain_writes::ProjectDeletePayload {
                project_id: "project-1".to_string(),
            },
        )
        .expect("trusted project delete without erasing audit ledger");

        let projects = db
            .execute(
                "SELECT count(*) AS n FROM projects WHERE id = 'project-1'",
                &[],
                "get",
            )
            .expect("query deleted project");
        assert_eq!(projects[0]["n"], Value::from(0));

        let lint_rows = db
            .execute(
                "SELECT count(*) AS n FROM lint_term_dictionary WHERE project_id = 'project-1'",
                &[],
                "get",
            )
            .expect("query deleted project dictionary rows");
        assert_eq!(lint_rows[0]["n"], Value::from(0));

        let rows = db
            .execute(
                "SELECT count(*) AS n FROM ai_audit_events WHERE project_id = 'project-1'",
                &[],
                "get",
            )
            .expect("query retained ledger");
        assert_eq!(rows[0]["n"], Value::from(1));

        for (table, predicate) in [
            ("narrative_extraction_runs", "id = 'run-delete'"),
            ("narrative_extraction_tasks", "id = 'task-delete'"),
            ("narrative_extraction_attempts", "id = 'attempt-delete'"),
            ("narrative_extraction_task_edges", "id = 'edge-delete'"),
            ("narrative_extraction_artifacts", "id = 'artifact-delete'"),
            ("narrative_proposal_sets", "id = 'set-delete'"),
            ("narrative_proposals", "id = 'proposal-delete'"),
            ("narrative_proposal_revisions", "id = 'revision-delete'"),
            (
                "narrative_revision_source_basis",
                "revision_id = 'revision-delete'",
            ),
            ("narrative_proposal_decisions", "id = 'decision-delete'"),
            ("narrative_apply_commits", "id = 'commit-delete'"),
            ("narrative_apply_operations", "id = 'operation-delete'"),
            ("narrative_commit_journals", "id = 'journal-delete'"),
            ("narrative_field_authority", "project_id = 'project-1'"),
        ] {
            let remaining = db
                .execute(
                    &format!("SELECT count(*) AS n FROM {table} WHERE {predicate}"),
                    &[],
                    "get",
                )
                .expect("query deleted narrative graph row");
            assert_eq!(
                remaining[0]["n"],
                Value::from(0),
                "project delete left rows in {table}"
            );
        }

        let missing = crate::domain_writes::project_delete(
            &db,
            crate::domain_writes::ProjectDeletePayload {
                project_id: "project-1".to_string(),
            },
        )
        .expect_err("repeated project delete must report not found");
        assert!(missing
            .to_string()
            .contains("project 'project-1' not found"));
    }

    #[test]
    fn renderer_batch_rejection_rolls_back_and_restores_trusted_connection_state() {
        let db = test_db();
        db.execute(
            "CREATE TABLE renderer_batch (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted schema setup");
        let attach_path = temp_sqlite_path("batch");
        let statements = vec![
            BatchStatement {
                sql: "INSERT INTO renderer_batch (id, value) VALUES (1, 'rolled back')".into(),
                params: vec![],
                method: "run".into(),
            },
            BatchStatement {
                sql: "ATTACH DATABASE ?1 AS audit".into(),
                params: vec![Value::String(attach_path.to_string_lossy().into_owned())],
                method: "run".into(),
            },
        ];

        let error = db
            .execute_batch_tx_renderer(&statements)
            .expect_err("renderer batch ATTACH must be rejected");
        assert!(
            error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied ATTACH or VACUUM"),
            "unexpected error: {error}"
        );
        let rows = db
            .execute("SELECT count(*) AS n FROM renderer_batch", &[], "get")
            .expect("query rollback result");
        assert_eq!(rows[0]["n"], Value::from(0));
        assert!(!attach_path.exists(), "batch ATTACH must not create a file");

        // The renderer policy is temporary. Trusted maintenance still needs
        // SQLite's internal VACUUM attachment after every success/failure.
        db.vacuum()
            .expect("trusted VACUUM works after renderer policy cleanup");
        let _ = std::fs::remove_file(attach_path);
    }

    #[test]
    fn renderer_sql_only_allows_narrow_read_only_pragmas_and_deferred_fk_batch() {
        let db = test_db();
        db.with_conn(|conn| {
            conn.pragma_update(None, "foreign_keys", true)?;
            Ok(())
        })
        .expect("enable foreign key enforcement for pragma guard regression");
        let rows = db
            .execute_renderer("PRAGMA user_version", &[], "get")
            .expect("read-only pragma");
        assert!(rows[0].contains_key("user_version"));

        let error = db
            .execute_renderer("PRAGMA foreign_keys = OFF", &[], "run")
            .expect_err("connection-mutating pragma must be rejected");
        assert!(
            error
                .to_string()
                .contains("RENDERER_SQL_SECURITY: denied PRAGMA foreign_keys"),
            "unexpected error: {error}"
        );

        let foreign_keys: i64 = db
            .with_conn(|conn| Ok(conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?))
            .expect("read foreign key setting after rejected pragma");
        assert_eq!(
            foreign_keys, 1,
            "rejected PRAGMA must not change the connection"
        );

        db.execute(
            "CREATE TABLE pragma_batch (id INTEGER PRIMARY KEY)",
            &[],
            "run",
        )
        .expect("trusted schema setup");
        db.execute_batch_tx_renderer(&[
            BatchStatement {
                sql: "PRAGMA defer_foreign_keys = ON".into(),
                params: vec![],
                method: "run".into(),
            },
            BatchStatement {
                sql: "INSERT INTO pragma_batch (id) VALUES (1)".into(),
                params: vec![],
                method: "run".into(),
            },
        ])
        .expect("structural restore pragma remains available");
    }

    #[test]
    fn renderer_rejects_active_protected_table_mutations_but_trusted_writer_passes() {
        let db = test_db();
        db.execute(
            "CREATE TABLE narrative_protected_fixture (
                id TEXT PRIMARY KEY,
                version INTEGER NOT NULL DEFAULT 1
             )",
            &[],
            "run",
        )
        .expect("trusted fixture schema");

        let insert_error = db
            .execute_renderer(
                "INSERT INTO narrative_protected_fixture (id, version) VALUES ('a', 1)",
                &[],
                "run",
            )
            .expect_err("renderer insert into protected fixture");
        assert!(
            insert_error
                .to_string()
                .contains("PROTECTED_WRITER_SQL: denied mutation of protected narrative table"),
            "unexpected error: {insert_error}"
        );

        db.execute(
            "INSERT INTO narrative_protected_fixture (id, version) VALUES ('a', 1)",
            &[],
            "run",
        )
        .expect("trusted domain writer may mutate protected tables");

        let update_error = db
            .execute_untrusted(
                SqlOrigin::McpGeneric,
                "UPDATE narrative_protected_fixture SET version = 2 WHERE id = 'a'",
                &[],
                "run",
            )
            .expect_err("mcp generic update denied");
        assert!(update_error.to_string().contains("PROTECTED_WRITER_SQL"));
    }

    /// `schema_data_migrations` decides whether a data migration re-runs, so
    /// it is migration authority, not diagnostics. Left unprotected, generic
    /// SQL could raise `contract_version` to fake a migration that never ran,
    /// or delete the row to force every open to discard C2 derived state.
    /// Only a trusted migration may write it.
    #[test]
    fn generic_sql_cannot_forge_the_data_migration_marker() {
        let db = test_db();
        db.execute(
            "CREATE TABLE schema_data_migrations (
                migration_id     TEXT PRIMARY KEY,
                contract_version INTEGER NOT NULL,
                applied_at       TEXT NOT NULL
             )",
            &[],
            "run",
        )
        .expect("trusted migration may create the marker table");
        db.execute(
            "INSERT INTO schema_data_migrations
                (migration_id, contract_version, applied_at)
             VALUES ('narrative-c2-identity-v28', 2, '2026-08-17T00:00:00.000Z')",
            &[],
            "run",
        )
        .expect("trusted migration may record its own completion");

        for (label, sql) in [
            (
                "insert",
                "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
                 VALUES ('forged', 999, '2026-08-17T00:00:00.000Z')",
            ),
            (
                "update",
                "UPDATE schema_data_migrations SET contract_version = 999
                  WHERE migration_id = 'narrative-c2-identity-v28'",
            ),
            (
                "delete",
                "DELETE FROM schema_data_migrations
                  WHERE migration_id = 'narrative-c2-identity-v28'",
            ),
        ] {
            let renderer = db
                .execute_renderer(sql, &[], "run")
                .expect_err("renderer must not reach migration authority");
            assert!(
                renderer.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                "renderer {label} was not denied: {renderer}"
            );

            let mcp = db
                .execute_untrusted(SqlOrigin::McpGeneric, sql, &[], "run")
                .expect_err("MCP generic must not reach migration authority");
            assert!(
                mcp.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                "MCP generic {label} was not denied: {mcp}"
            );
        }

        let (version, count) = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT
                        (SELECT contract_version FROM schema_data_migrations
                          WHERE migration_id = 'narrative-c2-identity-v28'),
                        (SELECT COUNT(*) FROM schema_data_migrations)",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )?)
            })
            .expect("read the marker back");
        assert_eq!(version, 2, "the marker must survive every denied write");
        assert_eq!(count, 1, "no forged marker row may exist");
    }

    #[test]
    fn renderer_rejects_protected_shared_columns_and_structural_writes() {
        let db = test_db();
        db.execute(
            "CREATE TABLE narrative_protected_shared_fixture (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                protected_col TEXT DEFAULT 'from-default',
                version INTEGER NOT NULL DEFAULT 1
             )",
            &[],
            "run",
        )
        .expect("trusted shared fixture");
        db.execute(
            "INSERT INTO narrative_protected_shared_fixture (id, title, protected_col, version)
             VALUES ('a', 'old', 'secret', 9)",
            &[],
            "run",
        )
        .expect("trusted seed");

        let insert_error = db
            .execute_renderer(
                "INSERT INTO narrative_protected_shared_fixture (id, title) VALUES ('b', 'ok')",
                &[],
                "run",
            )
            .expect_err("shared-table insert must fail closed");
        assert!(
            insert_error
                .to_string()
                .contains("PROTECTED_WRITER_SQL: denied insert into protected shared table"),
            "unexpected error: {insert_error}"
        );

        let replace_error = db
            .execute_renderer(
                "INSERT OR REPLACE INTO narrative_protected_shared_fixture (id, title)
                 VALUES ('a', 'new')",
                &[],
                "run",
            )
            .expect_err("INSERT OR REPLACE must fail closed");
        assert!(
            replace_error.to_string().contains("PROTECTED_WRITER_SQL"),
            "unexpected error: {replace_error}"
        );

        let delete_error = db
            .execute_renderer(
                "DELETE FROM narrative_protected_shared_fixture WHERE id = 'a'",
                &[],
                "run",
            )
            .expect_err("shared-table delete must fail closed");
        assert!(
            delete_error
                .to_string()
                .contains("PROTECTED_WRITER_SQL: denied delete from protected shared table"),
            "unexpected error: {delete_error}"
        );

        let protected_update = db
            .execute_renderer(
                "UPDATE narrative_protected_shared_fixture SET protected_col = 'no' WHERE id = 'a'",
                &[],
                "run",
            )
            .expect_err("protected column update denied");
        assert!(
            protected_update
                .to_string()
                .contains("PROTECTED_WRITER_SQL: denied update of protected column"),
            "unexpected error: {protected_update}"
        );

        let version_update = db
            .execute_renderer(
                "UPDATE narrative_protected_shared_fixture SET version = 99 WHERE id = 'a'",
                &[],
                "run",
            )
            .expect_err("version column update denied");
        assert!(
            version_update.to_string().contains("PROTECTED_WRITER_SQL"),
            "unexpected error: {version_update}"
        );

        db.execute_renderer(
            "UPDATE narrative_protected_shared_fixture SET title = 'later' WHERE id = 'a'",
            &[],
            "run",
        )
        .expect("unprotected column update remains available");

        let rows = db
            .execute(
                "SELECT title, protected_col, version FROM narrative_protected_shared_fixture WHERE id = 'a'",
                &[],
                "get",
            )
            .expect("read preserved protected values");
        assert_eq!(rows[0]["title"], Value::from("later"));
        assert_eq!(rows[0]["protected_col"], Value::from("secret"));
        assert_eq!(rows[0]["version"], Value::from(9));
    }

    #[test]
    fn renderer_rejects_project_insert_delete_and_metadata_update() {
        let db = test_db();
        db.migrate().expect("migrate");

        for sql in [
            "INSERT INTO projects (id, title) VALUES ('forged-project', 'Forged')",
            "DELETE FROM projects WHERE id = 'default-project'",
        ] {
            let error = db
                .execute_renderer(sql, &[], "run")
                .expect_err("renderer project lifecycle mutation must be denied");
            assert!(
                error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                "unexpected project lifecycle error: {error}"
            );
        }

        let error = db
            .execute_renderer(
                "UPDATE projects SET title = 'Renamed' WHERE id = 'default-project'",
                &[],
                "run",
            )
            .expect_err("project metadata must use the typed Native writer");
        assert!(error.to_string().contains(PROTECTED_WRITER_SQL_ERROR));
        let rows = db
            .execute(
                "SELECT title FROM projects WHERE id = 'default-project'",
                &[],
                "get",
            )
            .expect("read updated project");
        assert_eq!(rows[0]["title"], Value::from("Untitled Project"));
    }

    #[test]
    fn renderer_and_mcp_generic_sql_cannot_mutate_maintenance_feed_tables() {
        let db = test_db();
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title) VALUES ('feed-project', 'Feed')",
            &[],
            "run",
        )
        .expect("seed project");
        db.execute(
            "INSERT INTO narrative_change_cursors
             (project_id, consumer_id, acknowledged_through_sequence, updated_at)
             VALUES ('feed-project', 'native-consumer', 0, datetime('now'))",
            &[],
            "run",
        )
        .expect("trusted Native setup remains available");

        let feed_tables = [
            "narrative_change_transactions",
            "narrative_change_events",
            "narrative_change_cursors",
            "narrative_change_sets",
        ];
        for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
            for table in feed_tables {
                let error = db
                    .execute_untrusted(
                        origin,
                        &format!("DELETE FROM \"{table}\" WHERE 0"),
                        &[],
                        "run",
                    )
                    .expect_err("generic SQL must not delete from a feed table");
                assert!(
                    error.to_string().contains("PROTECTED_WRITER_SQL"),
                    "unexpected {origin:?} error for {table}: {error}"
                );
            }
        }

        let insert_error = db
            .execute_renderer(
                "INSERT INTO narrative_change_cursors
                 (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                 VALUES ('feed-project', 'renderer-consumer', 0, datetime('now'))",
                &[],
                "run",
            )
            .expect_err("renderer feed insert must be denied");
        assert!(insert_error.to_string().contains("PROTECTED_WRITER_SQL"));

        let update_error = db
            .execute_untrusted(
                SqlOrigin::McpGeneric,
                "UPDATE narrative_change_cursors
                 SET acknowledged_through_sequence = 1
                 WHERE project_id = 'feed-project' AND consumer_id = 'native-consumer'",
                &[],
                "run",
            )
            .expect_err("MCP feed update must be denied");
        assert!(update_error.to_string().contains("PROTECTED_WRITER_SQL"));

        db.execute(
            "UPDATE narrative_change_cursors
             SET acknowledged_through_sequence = 1
             WHERE project_id = 'feed-project' AND consumer_id = 'native-consumer'",
            &[],
            "run",
        )
        .expect("trusted Native mutation remains available");
    }

    #[test]
    fn active_domain_tables_reject_renderer_mutations_after_gate_b2_cutover() {
        let db = test_db();
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('p1', 'P', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed project");
        let insert_error = db
            .execute_renderer(
                "INSERT INTO events (id, project_id, title, created_at, updated_at)
                 VALUES ('e1', 'p1', 'Event', datetime('now'), datetime('now'))",
                &[],
                "run",
            )
            .expect_err("renderer cannot mutate active domain events table");
        assert!(
            insert_error
                .to_string()
                .contains("PROTECTED_WRITER_SQL: denied mutation of protected narrative table"),
            "unexpected error: {insert_error}"
        );
    }

    #[test]
    fn renderer_and_mcp_generic_sql_cannot_update_tree_titles() {
        let db = test_db();
        db.migrate().expect("migrate");
        db.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('tree-authority-project', 'Tree', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed project");
        db.execute(
            "INSERT INTO tree_nodes
             (id, project_id, node_type, title, sort_order, created_at, updated_at)
             VALUES ('tree-authority-node', 'tree-authority-project', 'scene', 'Before',
                     'a0', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("trusted Native seed");

        for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
            let error = db
                .execute_untrusted(
                    origin,
                    "UPDATE tree_nodes SET title = 'Bypassed' WHERE id = 'tree-authority-node'",
                    &[],
                    "run",
                )
                .expect_err("generic SQL cannot bypass the typed Tree writer");
            assert!(
                error.to_string().contains("PROTECTED_WRITER_SQL"),
                "unexpected {origin:?} error: {error}"
            );
        }

        let rows = db
            .execute(
                "SELECT title FROM tree_nodes WHERE id = 'tree-authority-node'",
                &[],
                "get",
            )
            .expect("read trusted seed");
        assert_eq!(rows[0]["title"], Value::from("Before"));
    }

    #[test]
    fn untrusted_read_only_sql_does_not_churn_reserved_project_setting_guard() {
        let db = test_db();
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TEMP TRIGGER grimodex_guard_reserved_project_setting_insert
                 AFTER INSERT ON main.project_settings
                 WHEN 0 BEGIN SELECT 1; END",
            )?;
            Ok(())
        })
        .expect("create benign temporary trigger sentinel");

        for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
            db.execute_untrusted(origin, "SELECT 1 AS value", &[], "all")
                .unwrap_or_else(|error| panic!("{origin:?} read-only SQL: {error}"));
            db.execute_batch_tx_untrusted(
                origin,
                &[
                    BatchStatement {
                        sql: "SELECT 1 AS value".to_string(),
                        params: vec![],
                        method: "all".to_string(),
                    },
                    BatchStatement {
                        sql: "SELECT 2 AS value".to_string(),
                        params: vec![],
                        method: "all".to_string(),
                    },
                ],
            )
            .unwrap_or_else(|error| panic!("{origin:?} read-only batch: {error}"));
        }

        let sentinel = db
            .execute(
                "SELECT count(*) AS count FROM temp.sqlite_master
                 WHERE type = 'trigger'
                   AND name = 'grimodex_guard_reserved_project_setting_insert'",
                &[],
                "get",
            )
            .expect("inspect read-only trigger sentinel");
        assert_eq!(sentinel[0]["count"], Value::from(1));
    }

    #[test]
    fn untrusted_sql_readonly_probe_fails_closed_for_non_readonly_statements() {
        let cases = [
            ("SELECT 1", false),
            ("-- leading comment\nSELECT 1", true),
            (
                "WITH values_cte AS (SELECT 1) SELECT * FROM values_cte",
                true,
            ),
            ("EXPLAIN SELECT 1", false),
            (
                "INSERT INTO project_settings (project_id, key, value) VALUES (?1, ?2, ?3)",
                true,
            ),
            (
                "UPDATE project_settings SET value = ?1 WHERE project_id = ?2 AND key = ?3",
                true,
            ),
            (
                "DELETE FROM project_settings WHERE project_id = ?1 AND key = ?2",
                true,
            ),
            (
                "WITH values_cte AS (SELECT 1) INSERT INTO project_settings
                 (project_id, key, value) VALUES (?1, ?2, ?3)",
                true,
            ),
            ("not valid SQLite", true),
        ];
        for (sql, expected_guard) in cases {
            assert_eq!(
                untrusted_sql_needs_reserved_project_setting_guard(sql),
                expected_guard,
                "unexpected readonly probe result for {sql:?}"
            );
        }
    }

    #[test]
    fn untrusted_sql_cannot_mutate_reserved_scan_marker_but_trusted_can() {
        let db = test_db();
        db.migrate().expect("migrate database");
        for (name, operation) in [
            (RESERVED_PROJECT_SETTING_INSERT_TRIGGER, "AFTER INSERT"),
            (RESERVED_PROJECT_SETTING_UPDATE_TRIGGER, "AFTER UPDATE"),
            (RESERVED_PROJECT_SETTING_DELETE_TRIGGER, "AFTER DELETE"),
        ] {
            db.execute(
                &format!(
                    "CREATE TRIGGER {name} {operation} ON project_settings
                     WHEN 0 BEGIN SELECT 1; END"
                ),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("create persistent trigger {name}: {error}"));
        }
        db.execute(
            "INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
             VALUES ('scan-marker-guard', 'Scan marker guard', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed project");
        db.execute(
            "INSERT INTO project_settings (project_id, key, value)
             VALUES ('scan-marker-guard', 'ordinary.setting', 'before')",
            &[],
            "run",
        )
        .expect("trusted ordinary project setting");
        db.execute(
            "INSERT INTO project_settings (project_id, key, value)
             VALUES (?1, ?2, ?3)",
            &[
                Value::from("scan-marker-guard"),
                Value::from(SCAN_IMPORT_STATE_KEY),
                Value::from("staging"),
            ],
            "run",
        )
        .expect("trusted Native may create the Scan marker");

        let attempts = [
            (
                "insert-literal",
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-guard', 'scan.import.state', 'forged')",
                vec![],
            ),
            (
                "insert-bound",
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES (?1, ?2, ?3)",
                vec![
                    Value::from("scan-marker-guard"),
                    Value::from(SCAN_IMPORT_STATE_KEY),
                    Value::from("forged"),
                ],
            ),
            (
                "update-literal",
                "UPDATE project_settings SET value = 'forged'
                 WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
                vec![],
            ),
            (
                "update-bound",
                "UPDATE project_settings SET value = ?1
                 WHERE project_id = ?2 AND key = ?3",
                vec![
                    Value::from("forged"),
                    Value::from("scan-marker-guard"),
                    Value::from(SCAN_IMPORT_STATE_KEY),
                ],
            ),
            (
                "update-expression",
                "UPDATE project_settings SET value = 'forged'
                 WHERE project_id = 'scan-marker-guard'
                   AND key = printf('%s', 'scan.import.state')",
                vec![],
            ),
            (
                "update-to-reserved-key",
                "UPDATE project_settings SET key = 'scan.import.state'
                 WHERE project_id = 'scan-marker-guard' AND key = 'ordinary.setting'",
                vec![],
            ),
            (
                "update-from-reserved-key",
                "UPDATE project_settings SET key = 'ordinary.renamed'
                 WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
                vec![],
            ),
            (
                "delete-literal",
                "DELETE FROM project_settings
                 WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
                vec![],
            ),
            (
                "delete-bound",
                "DELETE FROM project_settings WHERE project_id = ?1 AND key = ?2",
                vec![
                    Value::from("scan-marker-guard"),
                    Value::from(SCAN_IMPORT_STATE_KEY),
                ],
            ),
            (
                "replace",
                "INSERT OR REPLACE INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-guard', 'scan.import.state', 'forged')",
                vec![],
            ),
            (
                "upsert-reserved",
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-guard', 'scan.import.state', 'forged')
                 ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
                vec![],
            ),
        ];

        for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
            for (label, sql, params) in &attempts {
                let error = db
                    .execute_untrusted(origin, sql, params, "run")
                    .expect_err("untrusted SQL must not mutate the Scan marker");
                assert!(
                    error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                    "unexpected {origin:?} {label} error: {error}"
                );
            }

            db.execute_untrusted(
                origin,
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-guard', 'ordinary.insert', 'inserted')",
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("{origin:?} ordinary insert: {error}"));
            db.execute_untrusted(
                origin,
                "UPDATE project_settings SET value = 'updated'
                 WHERE project_id = 'scan-marker-guard' AND key = 'ordinary.setting'",
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("{origin:?} ordinary update: {error}"));
            db.execute_untrusted(
                origin,
                "DELETE FROM project_settings
                 WHERE project_id = 'scan-marker-guard' AND key = 'ordinary.insert'",
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("{origin:?} ordinary delete: {error}"));

            let batch = vec![
                BatchStatement {
                    sql: "INSERT INTO project_settings (project_id, key, value)
                          VALUES ('scan-marker-guard', 'ordinary.batch', 'inserted')"
                        .to_string(),
                    params: vec![],
                    method: "run".to_string(),
                },
                BatchStatement {
                    sql: "INSERT INTO project_settings (project_id, key, value)
                          VALUES (?1, ?2, ?3)"
                        .to_string(),
                    params: vec![
                        Value::from("scan-marker-guard"),
                        Value::from(SCAN_IMPORT_STATE_KEY),
                        Value::from("forged"),
                    ],
                    method: "run".to_string(),
                },
            ];
            let batch_error = db
                .execute_batch_tx_untrusted(origin, &batch)
                .expect_err("untrusted batch must roll back before the reserved marker");
            assert!(
                batch_error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                "unexpected {origin:?} batch error: {batch_error}"
            );
            let batch_rows = db
                .execute(
                    "SELECT count(*) AS count FROM project_settings
                     WHERE project_id = 'scan-marker-guard' AND key = 'ordinary.batch'",
                    &[],
                    "get",
                )
                .expect("inspect rolled-back ordinary batch row");
            assert_eq!(batch_rows[0]["count"], Value::from(0));
            db.execute_untrusted(
                origin,
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-guard', 'ordinary.after_batch', 'inserted')",
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("{origin:?} policy cleanup: {error}"));
            db.execute_untrusted(
                origin,
                "DELETE FROM project_settings
                 WHERE project_id = 'scan-marker-guard' AND key = 'ordinary.after_batch'",
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("{origin:?} policy cleanup delete: {error}"));
        }

        let marker = db
            .execute(
                "SELECT value FROM project_settings
                 WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
                &[],
                "get",
            )
            .expect("read preserved Scan marker");
        assert_eq!(marker[0]["value"], Value::from("staging"));

        db.execute(
            "UPDATE project_settings SET value = 'published'
             WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
            &[],
            "run",
        )
        .expect("trusted Native may update the Scan marker");
        db.execute(
            "DELETE FROM project_settings
             WHERE project_id = 'scan-marker-guard' AND key = 'scan.import.state'",
            &[],
            "run",
        )
        .expect("trusted Native may remove the Scan marker");

        let persistent_triggers = db
            .execute(
                "SELECT count(*) AS count FROM main.sqlite_master
                 WHERE type = 'trigger'
                   AND name LIKE 'grimodex_guard_reserved_project_setting_%'",
                &[],
                "get",
            )
            .expect("read persistent guard trigger names");
        assert_eq!(persistent_triggers[0]["count"], Value::from(3));
    }

    #[test]
    fn untrusted_sql_cannot_mutate_native_timelapse_settings_in_single_or_batch_dml() {
        let db = test_db();
        db.migrate().expect("migrate database");
        db.execute(
            "INSERT OR IGNORE INTO projects (id, title, created_at, updated_at)
             VALUES ('timelapse-setting-guard', 'Timelapse setting guard', datetime('now'), datetime('now'))",
            &[],
            "run",
        )
        .expect("seed project");

        for (key, initial_value) in [
            ("timelapse.enabled", "true"),
            ("timelapse.resetSequence", "42"),
        ] {
            db.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES (?1, ?2, ?3)",
                &[
                    Value::from("timelapse-setting-guard"),
                    Value::from(key),
                    Value::from(initial_value),
                ],
                "run",
            )
            .expect("trusted Native may seed the timelapse setting");
            db.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('timelapse-setting-guard', 'ordinary.setting', 'before')
                 ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
                &[],
                "run",
            )
            .expect("seed ordinary setting");

            let attempts = vec![
                (
                    "insert-literal".to_string(),
                    format!(
                        "INSERT INTO project_settings (project_id, key, value)
                         VALUES ('timelapse-setting-guard', '{key}', 'forged')"
                    ),
                    vec![],
                ),
                (
                    "insert-bound".to_string(),
                    "INSERT INTO project_settings (project_id, key, value)
                     VALUES (?1, ?2, ?3)"
                        .to_string(),
                    vec![
                        Value::from("timelapse-setting-guard"),
                        Value::from(key),
                        Value::from("forged"),
                    ],
                ),
                (
                    "update-literal".to_string(),
                    format!(
                        "UPDATE project_settings SET value = 'forged'
                         WHERE project_id = 'timelapse-setting-guard' AND key = '{key}'"
                    ),
                    vec![],
                ),
                (
                    "update-bound".to_string(),
                    "UPDATE project_settings SET value = ?1
                     WHERE project_id = ?2 AND key = ?3"
                        .to_string(),
                    vec![
                        Value::from("forged"),
                        Value::from("timelapse-setting-guard"),
                        Value::from(key),
                    ],
                ),
                (
                    "update-to-reserved-key".to_string(),
                    format!(
                        "UPDATE project_settings SET key = '{key}'
                         WHERE project_id = 'timelapse-setting-guard' AND key = 'ordinary.setting'"
                    ),
                    vec![],
                ),
                (
                    "update-from-reserved-key".to_string(),
                    format!(
                        "UPDATE project_settings SET key = 'ordinary.renamed'
                         WHERE project_id = 'timelapse-setting-guard' AND key = '{key}'"
                    ),
                    vec![],
                ),
                (
                    "delete-literal".to_string(),
                    format!(
                        "DELETE FROM project_settings
                         WHERE project_id = 'timelapse-setting-guard' AND key = '{key}'"
                    ),
                    vec![],
                ),
                (
                    "delete-bound".to_string(),
                    "DELETE FROM project_settings WHERE project_id = ?1 AND key = ?2".to_string(),
                    vec![Value::from("timelapse-setting-guard"), Value::from(key)],
                ),
                (
                    "replace".to_string(),
                    format!(
                        "INSERT OR REPLACE INTO project_settings (project_id, key, value)
                         VALUES ('timelapse-setting-guard', '{key}', 'forged')"
                    ),
                    vec![],
                ),
                (
                    "upsert-reserved".to_string(),
                    format!(
                        "INSERT INTO project_settings (project_id, key, value)
                         VALUES ('timelapse-setting-guard', '{key}', 'forged')
                         ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value"
                    ),
                    vec![],
                ),
            ];

            for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
                for (label, sql, params) in &attempts {
                    let error = db
                        .execute_untrusted(origin, sql, params, "run")
                        .expect_err("untrusted SQL must not mutate Native timelapse settings");
                    assert!(
                        error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                        "unexpected {origin:?} {key} {label} error: {error}"
                    );
                }

                let batch = vec![
                    BatchStatement {
                        sql: "INSERT INTO project_settings (project_id, key, value)
                              VALUES ('timelapse-setting-guard', 'ordinary.batch', 'inserted')"
                            .to_string(),
                        params: vec![],
                        method: "run".to_string(),
                    },
                    BatchStatement {
                        sql: format!(
                            "UPDATE project_settings SET value = 'forged'
                             WHERE project_id = 'timelapse-setting-guard' AND key = '{key}'"
                        ),
                        params: vec![],
                        method: "run".to_string(),
                    },
                ];
                let batch_error = db
                    .execute_batch_tx_untrusted(origin, &batch)
                    .expect_err("untrusted batch must roll back before Native setting mutation");
                assert!(
                    batch_error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                    "unexpected {origin:?} {key} batch error: {batch_error}"
                );
                let batch_rows = db
                    .execute(
                        "SELECT count(*) AS count FROM project_settings
                         WHERE project_id = 'timelapse-setting-guard' AND key = 'ordinary.batch'",
                        &[],
                        "get",
                    )
                    .expect("inspect rolled-back Native-setting batch");
                assert_eq!(batch_rows[0]["count"], Value::from(0));
            }

            let value = db
                .execute(
                    &format!(
                        "SELECT value FROM project_settings
                         WHERE project_id = 'timelapse-setting-guard' AND key = '{key}'"
                    ),
                    &[],
                    "get",
                )
                .expect("read preserved Native timelapse setting");
            assert_eq!(value[0]["value"], Value::from(initial_value));
        }

        // Typed Native code does not use the untrusted authorizer/trigger
        // path, so it remains able to update both reserved keys.
        db.execute(
            "UPDATE project_settings SET value = 'false'
             WHERE project_id = 'timelapse-setting-guard' AND key = 'timelapse.enabled'",
            &[],
            "run",
        )
        .expect("trusted Native may update timelapse.enabled");
        db.execute(
            "UPDATE project_settings SET value = '43'
             WHERE project_id = 'timelapse-setting-guard' AND key = 'timelapse.resetSequence'",
            &[],
            "run",
        )
        .expect("trusted Native may update timelapse.resetSequence");
    }

    #[test]
    fn c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes() {
        let db = test_db();
        let tables = [
            "narrative_semantic_epochs",
            "narrative_extraction_runs",
            "narrative_dependency_edges",
            "narrative_dependency_edge_states",
            "narrative_consumer_freshness",
            "narrative_semantic_index_metadata",
            "narrative_nir1_chronicle_vectors",
            "narrative_maintenance_finding_lifecycle",
            "narrative_maintenance_finding_observations",
            "narrative_maintenance_repair_leases",
            "change_events",
            "state_snapshots",
        ];

        for table in tables {
            db.execute(
                &format!("CREATE TABLE {table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("create {table}: {error}"));
            db.execute(
                &format!("INSERT INTO {table} (id, value) VALUES ('trusted-seed', 'before')"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted insert {table}: {error}"));

            for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
                let rows = db
                    .execute_untrusted(
                        origin,
                        &format!("SELECT value FROM {table} WHERE id = 'trusted-seed'"),
                        &[],
                        "get",
                    )
                    .unwrap_or_else(|error| panic!("{origin:?} SELECT {table}: {error}"));
                assert_eq!(
                    rows[0]["value"],
                    Value::from("before"),
                    "{origin:?} {table}"
                );

                for (operation, sql) in [
                    (
                        "insert",
                        format!(
                            "INSERT INTO {table} (id, value) VALUES ('untrusted-insert', 'forged')"
                        ),
                    ),
                    (
                        "update",
                        format!("UPDATE {table} SET value = 'forged' WHERE id = 'trusted-seed'"),
                    ),
                    (
                        "delete",
                        format!("DELETE FROM {table} WHERE id = 'trusted-seed'"),
                    ),
                    (
                        "replace",
                        format!(
                            "REPLACE INTO {table} (id, value) VALUES ('trusted-seed', 'forged')"
                        ),
                    ),
                ] {
                    let error = db
                        .execute_untrusted(origin, &sql, &[], "run")
                        .expect_err("untrusted C2-ZC DML must be rejected");
                    assert!(
                        error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                        "{origin:?} {operation} {table} was not protected: {error}"
                    );
                }
            }

            db.execute(
                &format!("UPDATE {table} SET value = 'trusted-update' WHERE id = 'trusted-seed'"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted update {table}: {error}"));
            db.execute(
                &format!("INSERT INTO {table} (id, value) VALUES ('trusted-insert', 'trusted')"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted second insert {table}: {error}"));
            db.execute(
                &format!(
                    "REPLACE INTO {table} (id, value) VALUES ('trusted-seed', 'trusted-replace')"
                ),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted replace {table}: {error}"));
            db.execute(
                &format!("DELETE FROM {table} WHERE id = 'trusted-insert'"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted delete {table}: {error}"));

            let rows = db
                .execute(
                    &format!("SELECT value FROM {table} WHERE id = 'trusted-seed'"),
                    &[],
                    "get",
                )
                .unwrap_or_else(|error| panic!("trusted SELECT {table}: {error}"));
            assert_eq!(rows[0]["value"], Value::from("trusted-replace"), "{table}");
        }
    }

    #[test]
    fn timelapse_canonical_tables_reject_renderer_and_mcp_batch_dml_but_allow_reads() {
        let db = test_db();
        db.execute(
            "CREATE TABLE renderer_batch_guard (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
            &[],
            "run",
        )
        .expect("trusted batch guard schema");

        for table in ["change_events", "state_snapshots"] {
            db.execute(
                &format!("CREATE TABLE {table} (id TEXT PRIMARY KEY, value TEXT NOT NULL)"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("create {table}: {error}"));
            db.execute(
                &format!("INSERT INTO {table} (id, value) VALUES ('trusted-seed', 'before')"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted seed {table}: {error}"));

            for origin in [SqlOrigin::Renderer, SqlOrigin::McpGeneric] {
                let rows = db
                    .execute_untrusted(
                        origin,
                        &format!("SELECT value FROM {table} WHERE id = 'trusted-seed'"),
                        &[],
                        "get",
                    )
                    .unwrap_or_else(|error| panic!("{origin:?} SELECT {table}: {error}"));
                assert_eq!(rows[0]["value"], Value::from("before"));

                let single_sql =
                    format!("UPDATE {table} SET value = 'forged' WHERE id = 'trusted-seed'");
                let single_error = match origin {
                    SqlOrigin::Renderer => db
                        .execute_renderer(&single_sql, &[], "run")
                        .expect_err("renderer timelapse DML must be rejected"),
                    SqlOrigin::McpGeneric => db
                        .execute_untrusted(origin, &single_sql, &[], "run")
                        .expect_err("MCP timelapse DML must be rejected"),
                    _ => unreachable!("test only covers untrusted origins"),
                };
                assert!(
                    single_error
                        .to_string()
                        .contains(PROTECTED_WRITER_SQL_ERROR),
                    "{origin:?} single UPDATE {table} was not protected: {single_error}"
                );

                let batch = [
                    BatchStatement {
                        sql: "INSERT INTO renderer_batch_guard (id, value) VALUES ('rolled-back', 'temporary')"
                            .into(),
                        params: vec![],
                        method: "run".into(),
                    },
                    BatchStatement {
                        sql: format!(
                            "UPDATE {table} SET value = 'forged' WHERE id = 'trusted-seed'"
                        ),
                        params: vec![],
                        method: "run".into(),
                    },
                ];
                let error = match origin {
                    SqlOrigin::Renderer => db
                        .execute_batch_tx_renderer(&batch)
                        .expect_err("renderer timelapse batch DML must be rejected"),
                    SqlOrigin::McpGeneric => db
                        .execute_batch_tx_untrusted(origin, &batch)
                        .expect_err("MCP timelapse batch DML must be rejected"),
                    _ => unreachable!("test only covers untrusted origins"),
                };
                assert!(
                    error.to_string().contains(PROTECTED_WRITER_SQL_ERROR),
                    "{origin:?} batch UPDATE {table} was not protected: {error}"
                );

                let rows = db
                    .execute(
                        "SELECT value FROM renderer_batch_guard WHERE id = 'rolled-back'",
                        &[],
                        "get",
                    )
                    .unwrap_or_else(|error| panic!("inspect {origin:?} rollback {table}: {error}"));
                assert!(
                    rows.is_empty(),
                    "{origin:?} batch must roll back prior writes"
                );

                let rows = db
                    .execute_renderer(
                        &format!("SELECT value FROM {table} WHERE id = 'trusted-seed'"),
                        &[],
                        "get",
                    )
                    .unwrap_or_else(|error| panic!("renderer SELECT {table}: {error}"));
                assert_eq!(rows[0]["value"], Value::from("before"));
            }

            db.execute(
                &format!("UPDATE {table} SET value = 'trusted-update' WHERE id = 'trusted-seed'"),
                &[],
                "run",
            )
            .unwrap_or_else(|error| panic!("trusted update {table}: {error}"));
        }
    }
}
