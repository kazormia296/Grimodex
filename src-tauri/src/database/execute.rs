use rusqlite::{params_from_iter, Connection};
use serde_json::Value;
use std::time::Instant;

use super::{BatchStatement, Database};

/// Phase 5 instrumentation: log when a single in-Rust DB call takes long
/// enough to plausibly cause a UI hitch. Split between `lock_wait` (time
/// blocked on `Database.conn.lock()`) and `sql` (time inside the connection
/// running the actual statements). The command-layer log adds a `total=`
/// figure so ws_state lock contention can be derived as
/// `total - lock_wait - sql`.
const SLOW_DB_CALL_MS: u128 = 50;

fn log_prefix(sql: &str) -> String {
    let trimmed = sql.trim_start();
    let head: String = trimmed.chars().take(80).collect();
    head.replace('\n', " ")
}

impl Database {
    /// Execute a list of SQL statements in a single transaction.
    /// Each item is `{ sql, params, method }`. Returns last statement's rows.
    /// Used when drizzle-proxy does not expose transactions natively.
    pub fn execute_batch_tx(
        &self,
        statements: &[BatchStatement],
    ) -> anyhow::Result<Vec<serde_json::Map<String, Value>>> {
        let lock_started = Instant::now();
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        conn.execute_batch("BEGIN")?;
        let mut last_rows = Vec::new();
        let result = (|| -> anyhow::Result<_> {
            for stmt in statements {
                last_rows = Self::execute_with_conn(&conn, &stmt.sql, &stmt.params, &stmt.method)?;
            }
            Ok(last_rows)
        })();
        let final_result = match result {
            Ok(rows) => {
                conn.execute_batch("COMMIT")?;
                Ok(rows)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        };
        let sql_ms = sql_started.elapsed().as_millis();
        if lock_wait_ms + sql_ms >= SLOW_DB_CALL_MS {
            let first_sql = statements
                .first()
                .map(|s| log_prefix(&s.sql))
                .unwrap_or_default();
            tracing::warn!(
                "database.execute_batch_tx lock_wait={}ms sql={}ms stmts={} first_sql={:?}",
                lock_wait_ms,
                sql_ms,
                statements.len(),
                first_sql
            );
        }
        final_result
    }

    pub(crate) fn execute_with_conn(
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
                map.insert(col_name.clone(), val);
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
        let lock_started = Instant::now();
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let lock_wait_ms = lock_started.elapsed().as_millis();

        let sql_started = Instant::now();
        let result = Self::execute_with_conn(&conn, sql, params, method);
        let sql_ms = sql_started.elapsed().as_millis();
        if lock_wait_ms + sql_ms >= SLOW_DB_CALL_MS {
            tracing::warn!(
                "database.execute lock_wait={}ms sql={}ms method={} sql={:?}",
                lock_wait_ms,
                sql_ms,
                method,
                log_prefix(sql)
            );
        }
        result
    }
}
