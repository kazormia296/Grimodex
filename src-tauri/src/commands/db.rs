use serde_json::Value;
use std::time::Instant;

use tauri::Manager;

use crate::database;

use super::{with_db, AppError, QueryResult, WorkspaceState};

/// Phase 5 instrumentation kept as a regression tripwire: warn only when a
/// single command takes long enough to plausibly cause a visible UI hitch.
/// The split between this log (`db_execute total=...`) and the per-call log
/// inside `database::execute` (`database.execute lock_wait=... sql=...`)
/// attributes time to ws_state lock vs conn lock vs SQL itself.
const SLOW_COMMAND_MS: u128 = 50;

fn sql_prefix(sql: &str) -> String {
    let trimmed = sql.trim_start();
    let head: String = trimmed.chars().take(80).collect();
    head.replace('\n', " ")
}

// ---------------------------------------------------------------------------
// DB コマンドの async 実行方針 (DB 健全性監査 M3)
// ---------------------------------------------------------------------------
// 素の #[tauri::command] (sync fn) は IPC を受けたメインスレッドでインライン
// 実行されるため、busy_timeout (5s) 待ちや遅い SQL がそのまま UI フリーズに
// なる。そこで DB を触る sync コマンドには一律 #[tauri::command(async)] を
// 付け、マルチスレッド tokio ランタイムへ退避する。本体は sync のままなので
// MutexGuard が await を跨ぐことはなく Send 境界の問題は発生しない
// (ロック順序 ws_state.inner → db.conn も不変)。
// 長時間 txn / CPU バウンドの少数コマンド (db_execute_batch / fts_optimize /
// fts_rebuild / fts_rebuild_en / repair_integrity / extract_codex_candidates /
// seed_sample_workspace / open_workspace) は tokio ワーカーを塞がないよう
// async fn + tauri::async_runtime::spawn_blocking で専用ブロッキングプールへ
// 逃がす (定形は commands/semantic.rs の semantic_index_scene を参照)。
// workspace 切替との並行は WorkspaceState.switching (swap 区間の明示拒否) と
// フロントの pre-switch quiesce で抑える。残余レースの整理:
// - open 中 (migrate/VACUUM 中 = swap 前) に発行された write は旧 DB に
//   正しく着弾する (switching は swap 直前まで立たない)。
// - swap 区間に走ったコマンドは WORKSPACE_SWITCHING の明示エラーで拒否される。
// - open 完了「後」に発行されたコマンドが新 DB に行くのは pre-M3 の FIFO
//   実行でも同じであり仕様 (発行済み write の取りこぼしはフロント quiesce が
//   防ぐ)。

#[tauri::command(async)]
pub(crate) fn db_execute(
    ws_state: tauri::State<'_, WorkspaceState>,
    sql: String,
    params: Vec<Value>,
    method: String,
) -> Result<QueryResult, AppError> {
    let started = Instant::now();
    let result = with_db(&ws_state, |db| {
        let rows = db.execute_renderer(&sql, &params, &method)?;
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
pub(crate) async fn db_execute_batch(
    app: tauri::AppHandle,
    statements: Vec<database::BatchStatement>,
) -> Result<QueryResult, AppError> {
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<QueryResult, AppError> {
        let ws_state = app.state::<WorkspaceState>();
        let started = Instant::now();
        let stmt_count = statements.len();
        let first_sql = statements
            .first()
            .map(|s| sql_prefix(&s.sql))
            .unwrap_or_default();
        let result = with_db(&ws_state, |db| {
            let rows = db.execute_batch_tx_renderer(&statements)?;
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
    })
    .await
    .map_err(|e| AppError::Anyhow(anyhow::anyhow!("spawn_blocking join error: {e}")))?;
    result
}
