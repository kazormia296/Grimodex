//! Grimodex Electron シェルの Rust バックエンド (Electron 移行 Phase 2 S2、
//! 設計書 §4.2 / §4.3)。
//!
//! `#[napi]` class `Backend` が grimodex-db の `WorkspaceState` を保持し、
//! 垂直スライスのコマンド群 + `onEvent` を Node (Electron main) へ公開する。
//!
//! - **全公開関数は async + `spawn_blocking`** (軽量 stat のみの
//!   `validate_workspace_path` を除く)。同期 `#[napi]` は Node main thread =
//!   Electron main プロセス全体をブロックする (Phase 0 スパイク実証) —
//!   busy_timeout 5s を踏んだ db_execute が全窓の IPC を止める事故を構造的に防ぐ。
//! - 返り値は当面 **JSON 文字列** (rows の二重シリアライズは Phase 3 の最適化
//!   候補として記録済み。§4.2)。
//! - エラーは `AppError` の Display 文字列をそのまま reason に載せる (§5.2 の
//!   文字列ワイヤ契約。convert.rs 参照)。

mod convert;
mod state;
#[cfg(test)]
mod test_link_stubs;

use std::path::PathBuf;
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::ThreadSafeCallContext;
use napi::JsFunction;
use napi_derive::napi;

use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::events::EventSink;
use grimodex_db::open::{open_workspace_sync, OpenDeps};
use grimodex_db::trash_bin::{self, TrashBinCreatePayload};
use grimodex_db::workspace::{self, GlobalSettings};
use grimodex_db::{with_db_state, AppError, BatchStatement, QueryResult};

use convert::{app_err_to_napi, from_wire, join_err_to_napi, params_array};
use state::{AppState, EventTsfn};

/// spawn_blocking + `AppError` → `napi::Error` 写像の定形。Tauri 側 M3 方針
/// (「db コマンドは async、長時間系は spawn_blocking」) の写像 (§4.2)。
async fn run_blocking<T, F>(f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce() -> std::result::Result<T, AppError> + Send + 'static,
{
    napi::tokio::task::spawn_blocking(f)
        .await
        .map_err(join_err_to_napi)?
        .map_err(app_err_to_napi)
}

#[napi]
pub struct Backend {
    state: Arc<AppState>,
}

#[napi]
impl Backend {
    /// `app_data_dir` は Electron main の `app.getPath("userData")` を明示注入
    /// (§4.2 / §6.8 — Phase 2 は `GrimodexElectronDev` 名で動かし、Tauri の
    /// com.miyakey.grimodex には触らない)。
    #[napi(constructor)]
    pub fn new(app_data_dir: String) -> Result<Backend> {
        let state =
            AppState::new(&app_data_dir).map_err(|e| Error::from_reason(format!("{e:#}")))?;
        // §7.1 の end-to-end 実証チャネルその 1。onEvent 登録前なので
        // EventQueue にバッファされ、登録時に flush される。schemaVersion は
        // スモークテストが PRAGMA user_version との一致検証に使う。
        state.events.emit(
            "backend:ready",
            serde_json::json!({ "schemaVersion": grimodex_core::SCHEMA_VERSION }),
        );
        Ok(Backend {
            state: Arc::new(state),
        })
    }

    /// drizzle-proxy (src/db/client.ts) の唯一の通り道 (§4.3 — これだけで
    /// CRUD の 9 割が生きる)。`params` は位置パラメータの JSON 配列、`method`
    /// は "run" | "get" | "all" | "values"。
    /// 返り値: `QueryResult` の JSON 文字列 `{"rows":[…]}` (Tauri ワイヤと同形)。
    #[napi]
    pub async fn db_execute(
        &self,
        sql: String,
        params: serde_json::Value,
        method: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let params = params_array(params)?;
            with_db_state(&state.ws, |db| {
                let rows = db.execute(&sql, &params, &method)?;
                Ok(serde_json::to_string(&QueryResult { rows })?)
            })
        })
        .await
    }

    /// 複数文を単一トランザクションで実行 (BEGIN IMMEDIATE、途中失敗で全
    /// ROLLBACK — grimodex-db の `execute_batch_tx`)。オートセーブの通り道。
    /// `statements` は `[{ sql, params, method }, …]`。
    /// 返り値: 最終文の rows を載せた `QueryResult` の JSON 文字列。
    #[napi]
    pub async fn db_execute_batch(&self, statements: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let statements: Vec<BatchStatement> = from_wire("statements", statements)?;
            with_db_state(&state.ws, |db| {
                let rows = db.execute_batch_tx(&statements)?;
                Ok(serde_json::to_string(&QueryResult { rows })?)
            })
        })
        .await
    }

    /// workspace を開く: backup → migrate → swap → RAII SwitchingGuard →
    /// recent-workspaces 更新 (`grimodex_db::open::open_workspace_sync` —
    /// Tauri コマンドと同一経路。A3 相互運用の根拠)。`on_swapped` は napi 側
    /// no-op (semantic キャッシュは Tauri シェル固有。§4.1)。
    /// 完了時に `workspace:opened` (FE 購読者なしのデバッグチャネル) を emit
    /// する (§7.1 の end-to-end 実証チャネルその 2)。
    /// 返り値: `{"name":…,"isExisting":…}` の JSON 文字列。
    #[napi]
    pub async fn open_workspace(&self, path: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let mut on_swapped = || {};
            let mut deps = OpenDeps {
                gs_path: &state.gs,
                on_swapped: &mut on_swapped,
            };
            let result = open_workspace_sync(&state.ws, &mut deps, &path)?;
            state
                .events
                .emit("workspace:opened", serde_json::json!({ "path": path }));
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// 既存 workspace 判定 (commands/workspace.rs の同名コマンドと同一実装)。
    /// 軽量 stat のみなので設計どおり同期のまま (§4.2「純関数の validate 除く」)。
    #[napi]
    pub fn validate_workspace_path(&self, path: String) -> bool {
        let p = PathBuf::from(&path);
        p.exists() && p.is_dir() && p.join("grimodex.db").exists()
    }

    /// 起動時に必ず呼ばれる (workspace/store.ts:152)。
    /// 返り値: `GlobalSettings` の JSON 文字列 (camelCase — Tauri ワイヤと同形)。
    #[napi]
    pub async fn get_global_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let settings = workspace::read_global_settings(&state.gs.path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// `settings` は GlobalSettings 全体 (camelCase オブジェクト)。tmp+rename の
    /// 原子的書き込みと write_lock 直列化は Tauri コマンドと同一経路。
    #[napi]
    pub async fn save_global_settings(&self, settings: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings: GlobalSettings = from_wire("settings", settings)?;
            let _guard = state
                .gs
                .write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            workspace::write_global_settings(&state.gs.path, &settings)?;
            Ok(())
        })
        .await
    }

    /// 監査チェーン append (commands/timelapse.rs の写像。編集ループ常連の
    /// 軽量 DB 書き込み。§4.3)。`events` は camelCase の AppendChangeEvent 配列
    /// (Tauri の camelCase→snake_case 自動変換は serde の rename_all が担う)。
    /// 返り値: `AppendResult` (`{"insertedCount":…,"tailSequence":…,"tailHash":…}`)
    /// の JSON 文字列。
    #[napi]
    pub async fn timelapse_append_batch(
        &self,
        project_id: String,
        session_id: String,
        events: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let events: Vec<AppendChangeEvent> = from_wire("events", events)?;
            with_db_state(&state.ws, |db| {
                let result = db.append_change_events(&project_id, &session_id, &events)?;
                Ok(serde_json::to_string(&result)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 作成 (commands/trash_bin.rs の写像 — 実装本体は
    /// `grimodex_db::trash_bin` を Tauri コマンドと共用)。trash_bin 5 コマンドは
    /// workspace 読み込み時に `trash_bin_list` が必ず呼ばれるため、垂直スライスに
    /// 含めないと Electron 起動のたびにゴミ箱エラートーストが出る (§4.3)。
    /// `payload` は camelCase の TrashBinCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名は snake_case) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: TrashBinCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = trash_bin::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 一覧 (deleted_at 降順、`limit` 省略時 50 件)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn trash_bin_list(&self, project_id: String, limit: Option<i64>) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = trash_bin::list(db, project_id, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 文字屑ゴミ箱: 1 件削除 (拾い上げ成功時にも呼ばれる)。
    #[napi]
    pub async fn trash_bin_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::delete(db, id))).await
    }

    /// 文字屑ゴミ箱: project 内全削除。
    #[napi]
    pub async fn trash_bin_clear_all(&self, project_id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| trash_bin::clear_all(db, project_id)))
            .await
    }

    /// 文字屑ゴミ箱: 期日切れ・件数超過の刈り取り (起動時に呼ばれる)。
    /// 返り値: 残件数 (i64) の JSON 文字列。
    #[napi]
    pub async fn trash_bin_prune(
        &self,
        project_id: String,
        retention_days: i64,
        max_count: i64,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let count = trash_bin::prune(db, project_id, retention_days, max_count)?;
                Ok(serde_json::to_string(&count)?)
            })
        })
        .await
    }

    /// FTS optimize (commands/integrity.rs の写像 — 実装は grimodex-db の
    /// `Database::fts_optimize` を Tauri と共用)。workspace open 後のアイドル
    /// タイミングで呼ばれる fail-soft コマンド。
    #[napi]
    pub async fn fts_optimize(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_optimize())).await
    }

    /// FTS 全再構築 (設定画面のデータカテゴリから明示実行)。
    #[napi]
    pub async fn fts_rebuild(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.fts_rebuild())).await
    }

    /// 英語 FTS の再構築 (英語プロジェクト作成時に fail-soft で呼ばれる)。
    #[napi]
    pub async fn fts_rebuild_en(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| db.rebuild_en_fts())).await
    }

    /// FTS 検索 (チャット recall / コマンドセンター検索 — 編集ループ常連)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn fts_search(
        &self,
        project_id: String,
        query: String,
        scope: String,
        limit: u32,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = db.search_fts(&project_id, &query, &scope, limit)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// 整合性チェック (IntegrityCheckDialog)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn integrity_check(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let report = db.integrity_check()?;
                Ok(serde_json::to_string(&report)?)
            })
        })
        .await
    }

    /// 整合性修復 (IntegrityCheckDialog — 長時間になりうるが spawn_blocking
    /// なので Node main thread は塞がない)。
    /// 返り値: レポート object の JSON 文字列。
    #[napi]
    pub async fn repair_integrity(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let report = db.repair_integrity()?;
                Ok(serde_json::to_string(&report)?)
            })
        })
        .await
    }

    /// main 起動時に 1 回登録する (§7.1)。コールバックは
    /// `(channel: string, payloadJson: string)` の 2 引数。登録前に emit された
    /// イベント (`backend:ready`) は登録時に emit 順で flush される。
    /// TSFn は unref 済み — 登録が Node のイベントループを生かし続けることは
    /// ない (プロセス終了を妨げない)。
    #[napi]
    pub fn on_event(&self, env: Env, callback: JsFunction) -> Result<()> {
        let mut tsfn: EventTsfn = callback.create_threadsafe_function(
            0,
            |ctx: ThreadSafeCallContext<(String, String)>| {
                let channel = ctx.env.create_string(&ctx.value.0)?;
                let payload = ctx.env.create_string(&ctx.value.1)?;
                Ok(vec![channel, payload])
            },
        )?;
        tsfn.unref(&env)?;
        self.state.events.register(tsfn);
        Ok(())
    }
}
