use rusqlite::{
    config::DbConfig,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    params_from_iter, Connection, ErrorCode,
};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Instant;

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

fn renderer_sql_rejection(ctx: AuthContext<'_>) -> Option<String> {
    if !matches!(ctx.database_name, None | Some("main") | Some("temp")) {
        return Some("access to an attached database".to_string());
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

fn with_renderer_sql_policy<T, F>(conn: &Connection, operation: F) -> anyhow::Result<T>
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
                    if denied.is_none() {
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

    let result = operation(conn);
    let cleanup_result = restore_renderer_sql_policy(conn, &state);
    if let Err(error) = cleanup_result {
        return Err(anyhow::anyhow!(
            "failed to restore SQLite policy after renderer SQL: {error}"
        ));
    }

    let denied = denied_reason.lock().ok().and_then(|reason| reason.clone());
    if let Some(reason) = denied {
        return Err(anyhow::anyhow!(
            "{RENDERER_SQL_SECURITY_ERROR}: denied {reason}"
        ));
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
        renderer_origin: bool,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let lock_started = Instant::now();
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if renderer_origin {
            with_renderer_sql_policy(&conn, |conn| {
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
                "database.execute_batch_tx lock_wait={}ms sql={}ms stmts={} renderer={} first_sql={:?}",
                lock_wait_ms,
                sql_ms,
                statements.len(),
                renderer_origin,
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
        self.execute_batch_tx_impl(statements, false)
    }

    /// Execute renderer-origin statements under the connection-local
    /// authorizer, defensive db-config, and resource limits.
    pub fn execute_batch_tx_renderer(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_batch_tx_impl(statements, true)
    }

    pub fn execute_with_conn(
        conn: &Connection,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
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
        self.execute_impl(sql, params, method, false)
    }

    /// Execute one renderer-origin statement under the restricted policy.
    pub fn execute_renderer(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        self.execute_impl(sql, params, method, true)
    }

    fn execute_impl(
        &self,
        sql: &str,
        params: &[Value],
        method: &str,
        renderer_origin: bool,
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let lock_started = Instant::now();
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = if renderer_origin {
            with_renderer_sql_policy(&conn, |conn| {
                Self::execute_with_conn(conn, sql, params, method)
            })
        } else {
            Self::execute_with_conn(&conn, sql, params, method)
        };
        let sql_ms = sql_started.elapsed().as_millis();
        if lock_wait_ms + sql_ms >= SLOW_DB_CALL_MS {
            tracing::warn!(
                "database.execute lock_wait={}ms sql={}ms method={} renderer={} sql={:?}",
                lock_wait_ms,
                sql_ms,
                method,
                renderer_origin,
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
}
