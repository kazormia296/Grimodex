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

impl SqlOrigin {
    pub fn is_untrusted(self) -> bool {
        matches!(self, Self::Renderer | Self::McpGeneric)
    }
}

thread_local! {
    static UNTRUSTED_SQL_ACTIVE: Cell<bool> = const { Cell::new(false) };
    static PENDING_INSERT_COLUMNS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}

const RENDERER_SQL_RESOURCE_ERROR: &str = "RENDERER_SQL_RESOURCE_LIMIT";
const RENDERER_SQL_LENGTH_LIMIT: i32 = 1_048_576;
const RENDERER_VDBE_OP_LIMIT: i32 = 250_000;
const RENDERER_PROGRESS_INTERVAL: i32 = 10_000;
const RENDERER_MAX_PROGRESS_CALLBACKS: usize = 5_000;

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
) -> anyhow::Result<()> {
    let mut first_error = None;
    keep_first_cleanup_error(
        &mut first_error,
        conn.progress_handler(0, None::<fn() -> bool>),
    );
    keep_first_cleanup_error(
        &mut first_error,
        conn.authorizer(None::<fn(AuthContext<'_>) -> Authorization>),
    );
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

fn with_untrusted_sql_policy<T, F>(conn: &Connection, operation: F) -> anyhow::Result<T>
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
        conn.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, RENDERER_SQL_LENGTH_LIMIT)?;
        conn.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, RENDERER_VDBE_OP_LIMIT)?;
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_CREATE, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_ATTACH_WRITE, false)?;
        conn.authorizer(Some(move |ctx: AuthContext<'_>| {
            if let Some(reason) = renderer_sql_rejection(ctx) {
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
        conn.progress_handler(
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
        let _ = restore_renderer_sql_policy(conn, &state);
        return Err(error.into());
    }

    UNTRUSTED_SQL_ACTIVE.with(|active| active.set(true));
    let result = operation(conn);
    UNTRUSTED_SQL_ACTIVE.with(|active| active.set(false));
    PENDING_INSERT_COLUMNS.with(|columns| {
        *columns.borrow_mut() = None;
    });

    let cleanup_result = restore_renderer_sql_policy(conn, &state);
    if let Err(error) = cleanup_result {
        return Err(anyhow::anyhow!(
            "failed to restore SQLite policy after renderer SQL: {error}"
        ));
    }

    let denied = denied_reason.lock().ok().and_then(|reason| reason.clone());
    if let Some(reason) = denied {
        let code = if reason.contains("protected") {
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
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        // BEGIN IMMEDIATE acquires the write lock up front. A plain (deferred)
        // BEGIN only takes it on the first write, so a writer on the same DB
        // file (e.g. the MCP process) could slip in between and turn a later
        // statement into SQLITE_BUSY_SNAPSHOT — which busy_timeout cannot retry.
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let mut last_rows = Vec::new();
        let result = (|| -> anyhow::Result<_> {
            for stmt in statements {
                last_rows = Self::execute_with_conn(conn, &stmt.sql, &stmt.params, &stmt.method)?;
            }
            Ok(last_rows)
        })();
        match result {
            Ok(rows) => match conn.execute_batch("COMMIT") {
                Ok(()) => Ok(rows),
                // A failed COMMIT (deferred FK check, busy, disk-full, ...) leaves
                // the transaction open on this shared single connection. Without
                // an explicit ROLLBACK the next caller inherits a zombie tx and
                // its writes silently ride on / get rolled back with it.
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error.into())
                }
            },
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    fn execute_batch_tx_impl(
        &self,
        statements: &[BatchStatement],
        origin: SqlOrigin,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let lock_started = Instant::now();
        let conn = self.lock_conn()?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if origin.is_untrusted() {
            with_untrusted_sql_policy(&conn, |conn| {
                Self::execute_batch_tx_with_conn(conn, statements)
            })
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
        self.execute_batch_tx_impl(statements, SqlOrigin::TrustedDomainWriter)
    }

    pub fn execute_batch_tx_with_origin(
        &self,
        origin: SqlOrigin,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_batch_tx_impl(statements, origin)
    }

    /// Execute renderer-origin statements under the connection-local
    /// authorizer, defensive db-config, and resource limits.
    pub fn execute_batch_tx_renderer(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_batch_tx_impl(statements, SqlOrigin::Renderer)
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
        self.execute_batch_tx_impl(statements, origin)
    }

    pub fn execute_with_conn(
        conn: &Connection,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        prepare_untrusted_statement_context(sql);
        if renderer_indirect_ai_audit_cascade(conn, sql)? {
            return Err(anyhow::anyhow!(
                "{RENDERER_SQL_SECURITY_ERROR}: denied mutation of ai_audit_events"
            ));
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
            conn.execute(sql, params_from_iter(param_refs.iter()))?;
            return Ok(vec![]);
        }

        let mut stmt = conn.prepare(sql)?;
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
            return Ok(result.into_iter().take(1).collect());
        }
        Ok(result)
    }

    pub fn execute(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_impl(sql, params, method, SqlOrigin::TrustedDomainWriter)
    }

    /// Execute one renderer-origin statement under the restricted policy.
    pub fn execute_renderer(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_impl(sql, params, method, SqlOrigin::Renderer)
    }

    pub fn execute_with_origin(
        &self,
        origin: SqlOrigin,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_impl(sql, params, method, origin)
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
        self.execute_impl(sql, params, method, origin)
    }

    fn execute_impl(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
        origin: SqlOrigin,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let lock_started = Instant::now();
        let conn = self.lock_conn()?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if origin.is_untrusted() {
            with_untrusted_sql_policy(&conn, |conn| {
                Self::execute_with_conn(conn, sql, params, method)
            })
        } else {
            Self::execute_with_conn(&conn, sql, params, method)
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
    use super::*;
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
}
