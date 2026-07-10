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

use grimodex_core::codex_matching::{CachedMatcher, CodexMatch, MatchEntry};
use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::events::EventSink;
use grimodex_db::agent_writes;
use grimodex_db::foreshadow::{
    self, ForeshadowCreatePayload, ForeshadowPatch, ForeshadowSetupPatch, OrphanResolvePayload,
    PayoffAnchorInput, SetupAnchorInput, SetupCreateAiInput,
};
use grimodex_db::open::{open_workspace_sync, OpenDeps};
use grimodex_db::plot_threads::{
    self, PlotThreadCreatePayload, PlotThreadLinkCreatePayload, PlotThreadLinkPatch,
    PlotThreadPatch,
};
use grimodex_db::post_effect::{self, ReplyToAnnotationArgs};
use grimodex_db::trash_bin::{self, TrashBinCreatePayload};
use grimodex_db::workspace::{self, GlobalSettings};
use grimodex_db::{with_db_state, AppError, BatchStatement, QueryResult};

use convert::{app_err_to_napi, from_wire, join_err_to_napi, lint_err_to_napi, params_array};
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

/// agent_writes 18 コマンドの定形写像。FE の `{ payload }` を DTO へ
/// deserialize し、共有 impl を with_db_state 上で呼んで結果 Value を JSON 文字列
/// で返す (Tauri の `with_db(&ws, |db| agent_xxx_impl(db, payload))` の写像)。
/// 各 impl 内で BEGIN IMMEDIATE → tracked write → commit_or_rollback が閉じる。
async fn agent_write_cmd<T, F>(
    state: Arc<AppState>,
    label: &'static str,
    payload: serde_json::Value,
    f: F,
) -> Result<String>
where
    T: serde::de::DeserializeOwned + Send + 'static,
    F: FnOnce(&grimodex_db::Database, T) -> anyhow::Result<serde_json::Value> + Send + 'static,
{
    run_blocking(move || {
        let dto: T = from_wire(label, payload)?;
        with_db_state(&state.ws, |db| Ok(serde_json::to_string(&f(db, dto)?)?))
    })
    .await
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

    /// Linter 本体 (commands/lint.rs の写像 — grimodex-lint を Tauri と共用)。
    /// State 非依存だが、UniDic コールドロード (初回 >数秒) + CPU バウンドなので
    /// spawn_blocking。エラーは AppError ではなく **LintError の {type,data}
    /// JSON** を reason に載せる (convert::lint_err_to_napi — ipcContract の
    /// lint_text アダプタが object reject へ復元する)。
    /// 返り値: `LintResponse` の JSON 文字列。
    #[napi]
    pub async fn lint_text(
        &self,
        blocks: serde_json::Value,
        language: String,
        scope: serde_json::Value,
        config: serde_json::Value,
        disables: Option<serde_json::Value>,
    ) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let blocks: Vec<grimodex_lint::LintBlock> =
                from_wire("blocks", blocks).map_err(app_err_to_napi)?;
            let scope: grimodex_lint::LintScope =
                from_wire("scope", scope).map_err(app_err_to_napi)?;
            let config: grimodex_lint::LintConfig =
                from_wire("config", config).map_err(app_err_to_napi)?;
            let disables: Vec<grimodex_lint::DisableDirective> = match disables {
                Some(v) => from_wire("disables", v).map_err(app_err_to_napi)?,
                None => Vec::new(),
            };
            // 言語分岐は commands/lint.rs と同一 (InvalidLanguage も LintError ワイヤ)
            let lang = match language.as_str() {
                "ja" => grimodex_lint::Language::Japanese,
                "en" => grimodex_lint::Language::English,
                other => {
                    return Err(lint_err_to_napi(
                        &grimodex_lint::LintError::InvalidLanguage(other.to_string()),
                    ))
                }
            };
            let response = grimodex_lint::lint(&blocks, lang, scope, &config, &disables)
                .map_err(|e| lint_err_to_napi(&e))?;
            serde_json::to_string(&response)
                .map_err(|e| Error::from_reason(format!("failed to serialize LintResponse: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// 段落プレーンテキストの文節分割 (commands/reorder.rs の写像)。
    /// UniDic コールドロードで初回 10s 超えうる (FE 側 SLOW_COMMANDS 登録済み)。
    /// 返り値: `[{start, end, surface}, …]` (UTF-16 offset) の JSON 文字列。
    #[napi]
    pub async fn segment_bunsetsu(&self, text: String) -> Result<String> {
        #[derive(serde::Serialize)]
        struct BunsetsuDto {
            start: u32,
            end: u32,
            surface: String,
        }
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            // サイズ上限とエラー文言は commands/reorder.rs と同一
            if text.len() > grimodex_lint::MAX_INPUT_BYTES {
                return Err(Error::from_reason(format!(
                    "text exceeds maximum length of {} bytes",
                    grimodex_lint::MAX_INPUT_BYTES
                )));
            }
            let chunks = grimodex_lint::bunsetsu::segment_bunsetsu(&text)
                .map_err(|e| Error::from_reason(e.to_string()))?;
            let dtos: Vec<BunsetsuDto> = chunks
                .into_iter()
                .map(|c| BunsetsuDto {
                    start: c.start,
                    end: c.end,
                    surface: c.surface,
                })
                .collect();
            serde_json::to_string(&dtos)
                .map_err(|e| Error::from_reason(format!("failed to serialize bunsetsu: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// システムフォント列挙 (commands/fonts.rs の写像 — 実装本体は
    /// grimodex-fonts を Tauri と共用)。OS のフォントディレクトリスキャンは
    /// 数百 ms かかりうるため spawn_blocking。
    /// 返り値: family 名配列 (昇順・重複排除) の JSON 文字列。
    #[napi]
    pub async fn list_system_fonts(&self) -> Result<String> {
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let families = grimodex_fonts::list_system_fonts();
            serde_json::to_string(&families)
                .map_err(|e| Error::from_reason(format!("failed to serialize fonts: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// Codex 名寄せマッチャの再構築 (commands/codex_matching.rs の写像 —
    /// 本体は grimodex-core::codex_matching を Tauri と共用)。`entries` は
    /// camelCase の MatchEntry 配列 (rustMatcher.ts が entryType/excludedAliases
    /// で送る)。Aho-Corasick 構築は CPU バウンドなので spawn_blocking。
    /// rebuild と match_text は AppState.codex_matcher の**同一インスタンス**を
    /// 見る (Tauri の CodexMatcherState 相当)。
    #[napi]
    pub async fn codex_rebuild_matcher(&self, entries: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<()> {
            let entries: Vec<MatchEntry> =
                from_wire("entries", entries).map_err(app_err_to_napi)?;
            let matcher = CachedMatcher::build(&entries)
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            let mut guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            *guard = Some(matcher);
            Ok(())
        })
        .await
        .map_err(join_err_to_napi)?
    }

    /// `text` を現在のマッチャで名寄せする (commands/codex_matching.rs の写像)。
    /// マッチャ未構築時は空配列 (Tauri 実装と同一の fail-soft)。高頻度 IPC だが
    /// 作法統一のため async + spawn_blocking。
    /// 返り値: `CodexMatch` (UTF-16 offset、camelCase) 配列の JSON 文字列。
    #[napi]
    pub async fn codex_match_text(
        &self,
        text: String,
        exclude_entry_ids: Vec<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        napi::tokio::task::spawn_blocking(move || -> Result<String> {
            let guard = state
                .codex_matcher
                .lock()
                .map_err(|e| Error::from_reason(format!("{e}")))?;
            let matches: Vec<CodexMatch> = match guard.as_ref() {
                None => vec![],
                Some(matcher) => matcher.match_text(&text, &exclude_entry_ids),
            };
            serde_json::to_string(&matches)
                .map_err(|e| Error::from_reason(format!("failed to serialize matches: {e}")))
        })
        .await
        .map_err(join_err_to_napi)?
    }

    // ─────────────────────── plot_threads (Phase 3 バッチ1 — grimodex-db の
    // plot_threads モジュールを Tauri と共用。commands/plot_threads.rs の写像) ──
    //
    // Value / Vec<Value> 返しは生の SQLite 行 (列名 snake_case)。patch 型の
    // Option<Option<String>> 3 値は from_wire (serde_json::from_value) が Tauri の
    // 引数 deserialize と同一挙動で受ける。link_create / link_update の XPROJ
    // ガードは shared impl 内でサーバサイド維持される (§4.3 — db_execute への
    // 分解禁止)。

    /// プロットスレッド作成 (commands/plot_threads.rs::plot_thread_create の写像)。
    /// `payload` は camelCase の PlotThreadCreatePayload。
    /// 返り値: 作成行 (`SELECT *`、列名 snake_case) の JSON 文字列。
    #[napi]
    pub async fn plot_thread_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド更新 (空 patch 時は現行行を返す)。`patch` は camelCase の
    /// PlotThreadPatch (color / description は Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// プロットスレッド削除。
    #[napi]
    pub async fn plot_thread_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| plot_threads::delete(db, id))).await
    }

    /// プロジェクトのスレッド一覧 (sort_order 昇順)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// スレッド↔シーンのリンク作成 (XPROJ ガード + phase_type 検証を含む)。
    /// `payload` は camelCase の PlotThreadLinkCreatePayload。
    /// 返り値: 作成行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: PlotThreadLinkCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// リンク更新 (別スレッドへの移動時は XPROJ ガード。空 patch 時は現行行)。
    /// `patch` は camelCase の PlotThreadLinkPatch (note / sortOrder は
    /// Option<Option<String>>)。
    /// 返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn plot_thread_link_update(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: PlotThreadLinkPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = plot_threads::link_update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// リンク削除。
    #[napi]
    pub async fn plot_thread_link_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| plot_threads::link_delete(db, id))).await
    }

    /// プロジェクトの全リンク (thread の project で JOIN 絞り込み)。
    /// 返り値: 行オブジェクト配列の JSON 文字列。
    #[napi]
    pub async fn plot_thread_list_links(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = plot_threads::list_links(db, project_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    // ─────────────────────── foreshadow (Phase 3 バッチ1 — grimodex-db の
    // foreshadow モジュールを Tauri と共用。commands/foreshadow.rs の写像) ──
    //
    // Value / Vec<Value> / 応答 struct は raw snake_case 行 or camelCase struct。
    // patch 型の Option<Option<T>> 3 値 + i64（save_anchors の from/to_pos、
    // setup_create_ai の pos 群）は from_wire (normalize_integer_numbers 込み) が
    // Tauri の引数 deserialize と同一挙動で受ける。foreshadow_list は FE 到達不能な
    // dead path のため napi ミラーは設けない。

    /// 伏線作成 (load_bearing 検証を含む)。`payload` は camelCase の
    /// ForeshadowCreatePayload。返り値: 作成行 (snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: ForeshadowCreatePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let row = foreshadow::create(db, payload)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// 伏線更新 (空 patch 時は現行行)。`patch` は ForeshadowPatch (多数の
    /// Option<Option<T>>)。返り値: 更新後行の JSON 文字列。
    #[napi]
    pub async fn foreshadow_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: ForeshadowPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| {
                let row = foreshadow::update(db, id, patch)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// 伏線削除。
    #[napi]
    pub async fn foreshadow_delete(&self, id: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || with_db_state(&state.ws, |db| foreshadow::delete(db, id))).await
    }

    /// 伏線 + setup ラベル行を 1 ロックで取得。返り値: ForeshadowListWithLabels
    /// Response (camelCase struct、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_with_labels(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_with_labels(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// 未解決 (open) 伏線 + setup ラベル行を 1 ロックで取得。
    #[napi]
    pub async fn foreshadow_list_open_for_context(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_open_for_context(db, project_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの setup/payoff 伏線 id。返り値: ForeshadowSceneInfoResponse
    /// (camelCase Vec<String>) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_info(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_info(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// シーンの伏線コンテキスト (3 クエリ、JOIN)。返り値: ForeshadowSceneContext
    /// Response の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_scene_context(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_scene_context(db, scene_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// codex エントリに紐づく伏線一覧。返り値: ForeshadowListWithLabelsResponse
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_by_codex_entry(&self, codex_entry_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::list_by_codex_entry(db, codex_entry_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// チャプターの伏線統計 (最重 read、5 クエリ)。返り値: ForeshadowChapterStats
    /// Bundle の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_chapter_stats(&self, chapter_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let res = foreshadow::get_chapter_stats(db, chapter_id)?;
                Ok(serde_json::to_string(&res)?)
            })
        })
        .await
    }

    /// setup 単体取得。返り値: 行 (snake_case) or null の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get_setup(&self, setup_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let row = foreshadow::get_setup(db, setup_id)?;
                Ok(serde_json::to_string(&row)?)
            })
        })
        .await
    }

    /// setup 更新 (空 patch は no-op)。`patch` は ForeshadowSetupPatch
    /// (Option<Option<T>>)。
    #[napi]
    pub async fn foreshadow_update_setup(
        &self,
        id: String,
        patch: serde_json::Value,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let patch: ForeshadowSetupPatch = from_wire("patch", patch)?;
            with_db_state(&state.ws, |db| foreshadow::update_setup(db, id, patch))
        })
        .await
    }

    /// 伏線 + その setup 群を取得。返り値: `{"foreshadow":…,"setups":[…]}`
    /// (キーは literal、内部行は snake_case) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_get(&self, id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let detail = foreshadow::get(db, id)?;
                Ok(serde_json::to_string(&detail)?)
            })
        })
        .await
    }

    /// 伏線↔codex リンク作成 (INSERT OR IGNORE)。
    #[napi]
    pub async fn foreshadow_link_codex(
        &self,
        foreshadow_id: String,
        codex_id: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                foreshadow::link_codex(db, foreshadow_id, codex_id)
            })
        })
        .await
    }

    /// 伏線↔codex リンク削除。
    #[napi]
    pub async fn foreshadow_unlink_codex(
        &self,
        foreshadow_id: String,
        codex_id: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                foreshadow::unlink_codex(db, foreshadow_id, codex_id)
            })
        })
        .await
    }

    /// 伏線に紐づく codex エントリ一覧。返り値: codex_entries.* 行 (snake_case)
    /// の JSON 文字列。
    #[napi]
    pub async fn foreshadow_list_linked_codex(&self, foreshadow_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows = foreshadow::list_linked_codex(db, foreshadow_id)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// setup の強度を直接更新 (`strength` は null で列クリア)。
    #[napi]
    pub async fn foreshadow_set_setup_strength(
        &self,
        setup_id: String,
        strength: Option<String>,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                foreshadow::set_setup_strength(db, setup_id, strength)
            })
        })
        .await
    }

    /// AI 由来 setup の upsert。`input` は camelCase の SetupCreateAiInput
    /// (fromPos/toPos は i64、lastEvaluatedAt は Option<i64> — from_wire が正規化)。
    #[napi]
    pub async fn foreshadow_setup_create_ai(&self, input: serde_json::Value) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let input: SetupCreateAiInput = from_wire("input", input)?;
            with_db_state(&state.ws, |db| foreshadow::setup_create_ai(db, input))
        })
        .await
    }

    /// orphan setup の解決 (reanchor / delete / reinsert)。`payload` は camelCase
    /// の OrphanResolvePayload (fromPos/toPos は Option<i64>)。
    /// 返り値: reinsert 時のみ new_id、その他は null の JSON 文字列。
    #[napi]
    pub async fn foreshadow_resolve_orphan(&self, payload: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let payload: OrphanResolvePayload = from_wire("payload", payload)?;
            with_db_state(&state.ws, |db| {
                let out = foreshadow::resolve_orphan(db, payload)?;
                Ok(serde_json::to_string(&out)?)
            })
        })
        .await
    }

    /// シーンのアンカーを一括保存 (batch tx)。`setups` / `payoffs` は camelCase
    /// の配列 (from/to_pos は i64)。`doc_content_size` は空 doc 判定の i64 ガード
    /// (<=2 で bulk-orphan)。
    #[napi]
    pub async fn foreshadow_save_anchors_for_scene(
        &self,
        scene_id: String,
        setups: serde_json::Value,
        payoffs: serde_json::Value,
        doc_content_size: i64,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let setups: Vec<SetupAnchorInput> = from_wire("setups", setups)?;
            let payoffs: Vec<PayoffAnchorInput> = from_wire("payoffs", payoffs)?;
            with_db_state(&state.ws, |db| {
                foreshadow::save_anchors_for_scene(db, scene_id, setups, payoffs, doc_content_size)
            })
        })
        .await
    }

    /// シーンのアンカー mark を取得 (0 座標・orphan を除外)。返り値:
    /// AnchorMarkOutput 配列 (camelCase: from/to/markName/attrs) の JSON 文字列。
    #[napi]
    pub async fn foreshadow_load_anchors_for_scene(&self, scene_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let marks = foreshadow::load_anchors_for_scene(db, scene_id)?;
                Ok(serde_json::to_string(&marks)?)
            })
        })
        .await
    }

    // ─────────────────────── agent_writes (Phase 3 バッチ1 — grimodex-db の
    // agent_writes モジュールを Tauri と共用。tracked write = BEGIN IMMEDIATE →
    // entity mutation + authorship_spans + undo_journal + change_events →
    // commit_or_rollback が各 impl 内で閉じる。XPROJ ガード / 楽観ロック /
    // undo-redo はサーバサイド維持) ──────────────────────────────────────────
    //
    // 18 コマンドはすべて FE が単一の `{ payload }` を送る。返り値は
    // AgentWriteResult / ProseStageResult (camelCase)。agent_write_cmd 定形で写像。

    #[napi]
    pub async fn agent_codex_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_codex_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_codex_update(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_codex_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_write_bundle(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_write_bundle_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_snippet_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_snippet_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_propose_scene_body(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_propose_scene_body_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_accept_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_accept_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_discard_prose_stage(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_discard_prose_stage_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_apply_undo_journal(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_undo_journal_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_foreshadow_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_foreshadow_update(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_foreshadow_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_create(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_create_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_update(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_update_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_delete(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_delete_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_event_set_participants(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            agent_writes::agent_event_set_participants_impl,
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_link(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p: grimodex_db::agent_writes::AgentSceneEventPayload| {
                agent_writes::agent_scene_event_mutate_impl(db, p, true)
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_scene_event_unlink(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p: grimodex_db::agent_writes::AgentSceneEventPayload| {
                agent_writes::agent_scene_event_mutate_impl(db, p, false)
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_add(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p: grimodex_db::agent_writes::AgentEventRelationPayload| {
                agent_writes::agent_event_relation_mutate_impl(db, p, true)
            },
        )
        .await
    }

    #[napi]
    pub async fn agent_event_relation_remove(&self, payload: serde_json::Value) -> Result<String> {
        agent_write_cmd(
            Arc::clone(&self.state),
            "payload",
            payload,
            |db, p: grimodex_db::agent_writes::AgentEventRelationPayload| {
                agent_writes::agent_event_relation_mutate_impl(db, p, false)
            },
        )
        .await
    }

    // ─────────────────────── post_effect (Phase 3 バッチ1 — pure-db 読み書き。
    // grimodex-db の post_effect モジュールを Tauri と共用。SCENE_LENS_FOR_PROJECT_SQL
    // 契約 / XPROJ ガード / snake_case ReplyToAnnotationArgs を維持。start_run 系と
    // abort・dead 2 件はバッチ3 以降) ──────────────────────────────────────────

    /// 校閲 run 一覧 (limit 省略時 20 / offset 省略時 0 はサーバサイド既定)。
    #[napi]
    pub async fn list_post_effect_runs(
        &self,
        project_id: String,
        effect_type: Option<String>,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let rows =
                    post_effect::list_post_effect_runs(db, project_id, effect_type, limit, offset)?;
                Ok(serde_json::to_string(&rows)?)
            })
        })
        .await
    }

    /// Outline 用: scene ごとに最新 run の lens (`runCompletedAt` 付き) を返す。
    #[napi]
    pub async fn list_scene_lens_for_project(&self, project_id: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_scene_lens_for_project(db, project_id)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation + relation を返す (`{annotations,relations}`)。
    #[napi]
    pub async fn list_annotations_for_scene(
        &self,
        project_id: String,
        scene_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v =
                    post_effect::list_annotations_for_scene(db, project_id, scene_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// プロジェクトの annotation を返す (`{annotations}`)。
    #[napi]
    pub async fn list_annotations_for_project(
        &self,
        project_id: String,
        status: Option<String>,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = post_effect::list_annotations_for_project(db, project_id, status)?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// annotation の status を更新 (XPROJ ガード付き、conn 直呼び)。
    #[napi]
    pub async fn update_annotation_status(
        &self,
        annotation_id: String,
        status: String,
        project_id: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| {
                    post_effect::update_annotation_status_inner(
                        conn,
                        &annotation_id,
                        &status,
                        &project_id,
                    )
                })?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// 疑似コメントへの返信を追加 (`args` は snake_case の ReplyToAnnotationArgs)。
    #[napi]
    pub async fn reply_to_annotation(&self, args: serde_json::Value) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let args: ReplyToAnnotationArgs = from_wire("args", args)?;
            with_db_state(&state.ws, |db| {
                let v = db.with_conn(|conn| post_effect::reply_to_annotation_inner(conn, &args))?;
                Ok(serde_json::to_string(&v)?)
            })
        })
        .await
    }

    /// シーンの annotation を保存 (raw snake_case 配列、range_start/end は i64)。
    #[napi]
    pub async fn save_post_effect_annotations(
        &self,
        project_id: String,
        scene_id: String,
        annotations: serde_json::Value,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let annotations: Vec<serde_json::Value> = from_wire("annotations", annotations)?;
            with_db_state(&state.ws, |db| {
                post_effect::save_post_effect_annotations(db, project_id, scene_id, annotations)
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
