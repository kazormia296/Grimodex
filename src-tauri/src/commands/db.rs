use serde_json::Value;
use std::time::Instant;

use crate::database;

use super::{with_db, AppError, QueryResult, WorkspaceState};

/// Phase 5 instrumentation: log when a single command takes long enough that
/// it can plausibly cause a visible UI hitch. The split between this log
/// (`db_execute total=...`) and the per-call log inside
/// `database::execute` (`database.execute lock_wait=... sql=...`) lets us
/// attribute the time to ws_state lock contention vs conn lock vs SQL itself.
const SLOW_COMMAND_MS: u128 = 50;

fn sql_prefix(sql: &str) -> String {
    let trimmed = sql.trim_start();
    let head: String = trimmed.chars().take(80).collect();
    head.replace('\n', " ")
}

#[tauri::command]
pub(crate) fn db_execute(
    ws_state: tauri::State<'_, WorkspaceState>,
    sql: String,
    params: Vec<Value>,
    method: String,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();
    let result = with_db(&ws_state, |db| {
        let rows = db.execute(&sql, &params, &method)?;
        Ok(QueryResult { rows })
    });
    let total_ms = started.elapsed().as_millis();
    if total_ms >= SLOW_COMMAND_MS {
        tracing::warn!(
            "db_execute total={}ms method={} sql={:?}",
            total_ms,
            method,
            sql_prefix(&sql)
        );
    }
    result
}

#[tauri::command]
pub(crate) fn db_execute_batch(
    ws_state: tauri::State<'_, WorkspaceState>,
    statements: Vec<database::BatchStatement>,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();
    let stmt_count = statements.len();
    let first_sql = statements
        .first()
        .map(|s| sql_prefix(&s.sql))
        .unwrap_or_default();
    let result = with_db(&ws_state, |db| {
        let rows = db.execute_batch_tx(&statements)?;
        Ok(QueryResult { rows })
    });
    let total_ms = started.elapsed().as_millis();
    if total_ms >= SLOW_COMMAND_MS {
        tracing::warn!(
            "db_execute_batch total={}ms stmts={} first_sql={:?}",
            total_ms,
            stmt_count,
            first_sql
        );
    }
    result
}
