use serde_json::Value;

use crate::database;

use super::{with_db, AppError, QueryResult, WorkspaceState};

#[tauri::command]
pub(crate) fn db_execute(
    ws_state: tauri::State<'_, WorkspaceState>,
    sql: String,
    params: Vec<Value>,
    method: String,
) -> Result<QueryResult, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute(&sql, &params, &method)?;
        Ok(QueryResult { rows })
    })
}

#[tauri::command]
pub(crate) fn db_execute_batch(
    ws_state: tauri::State<'_, WorkspaceState>,
    statements: Vec<database::BatchStatement>,
) -> Result<QueryResult, AppError> {
    with_db(&ws_state, |db| {
        let rows = db.execute_batch_tx(&statements)?;
        Ok(QueryResult { rows })
    })
}
