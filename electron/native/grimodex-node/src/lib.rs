//! Grimodex Electron シェルの Rust バックエンド (Electron 移行 Phase 2 S2、
//! 設計書 §4.2 / §4.3)。
//!
//! `#[napi]` class `Backend` が grimodex-db の `WorkspaceState` を保持し、
//! 垂直スライスのコマンド群 + `onEvent` を Node (Electron main) へ公開する。
//!
//! - **全公開関数は async + `spawn_blocking`** (軽量 stat の
//!   `validate_workspace_path` と、終了を確実に待つ
//!   `ime_export_deactivate_on_exit` を除く)。同期 `#[napi]` は Node main thread =
//!   Electron main プロセス全体をブロックする (Phase 0 スパイク実証) —
//!   busy_timeout 5s を踏んだ db_execute が全窓の IPC を止める事故を構造的に防ぐ。
//! - 返り値は当面 **JSON 文字列** (rows の二重シリアライズは Phase 3 の最適化
//!   候補として記録済み。§4.2)。
//! - エラーは `AppError` の Display 文字列をそのまま reason に載せる (§5.2 の
//!   文字列ワイヤ契約。convert.rs 参照)。

mod convert;
#[cfg(feature = "legacy-keyring-migration")]
mod legacy_keyring;
mod post_effect_runtime;
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
use grimodex_db::agent_writes;
use grimodex_db::backup_restore::{list_backups, restore_backup_core};
use grimodex_db::change_events::AppendChangeEvent;
use grimodex_db::events::EventSink;
use grimodex_db::foreshadow::{
    self, ForeshadowCreatePayload, ForeshadowPatch, ForeshadowSetupPatch, OrphanResolvePayload,
    PayoffAnchorInput, SetupAnchorInput, SetupCreateAiInput,
};
use grimodex_db::ime_export::{
    clear_all_exports, get_status as get_ime_export_status, refresh_project_export,
    remove_project_export_if_absent, resolve_mode_from_preferences,
    resolve_options_from_preferences, set_active_project, ImeExportOptions, ImeExportRequestGate,
    ImeExportRequestToken, ImeIntegrationMode,
};
use grimodex_db::open::{open_workspace_sync, OpenDeps};
use grimodex_db::plot_threads::{
    self, PlotThreadCreatePayload, PlotThreadLinkCreatePayload, PlotThreadLinkPatch,
    PlotThreadPatch,
};
use grimodex_db::post_effect::{self, ReplyToAnnotationArgs};
use grimodex_db::sample_seed;
use grimodex_db::state::{
    active_database, active_workspace_path, active_workspace_snapshot, ActiveWorkspaceSnapshot,
};
use grimodex_db::trash_bin::{self, TrashBinCreatePayload};
use grimodex_db::workspace::{self, GlobalSettings};
use grimodex_db::{with_db_state, AppError, BatchStatement, QueryResult};

use convert::{app_err_to_napi, from_wire, join_err_to_napi, lint_err_to_napi, params_array};
use post_effect_runtime::{NodePostEffectAiClient, NodePostEffectRuntime};
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

/// Semantic commandの共通境界。blocking poolへ投入する**前**にruntimeの
/// optimistic pin（epoch snapshot → active DB Arc → generation再確認）を完了し、
/// closure中にworkspace/epochを再解決しない。これにより切替待ち行列中でも
/// 1 commandが別DB/別cache generationへ跨らない。
async fn run_semantic_wire<T, F>(state: Arc<AppState>, operation: F) -> Result<String>
where
    T: serde::Serialize + Send + 'static,
    F: FnOnce(
            &grimodex_semantic::runtime::SemanticRuntime,
            &grimodex_semantic::runtime::SemanticRequest,
        ) -> anyhow::Result<T>
        + Send
        + 'static,
{
    let request = state
        .semantic
        .pin_request(|| active_database(&state.ws))
        .map_err(app_err_to_napi)?;
    let runtime = Arc::clone(&state.semantic);
    napi::tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        let value = operation(&runtime, &request)?;
        Ok(serde_json::to_string(&value)?)
    })
    .await
    .map_err(join_err_to_napi)?
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}

fn authoritative_ime_options(
    state: &AppState,
    fallback: &ImeExportOptions,
) -> std::result::Result<ImeExportOptions, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_options_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

fn authoritative_ime_mode(
    state: &AppState,
    fallback: ImeIntegrationMode,
) -> std::result::Result<ImeIntegrationMode, AppError> {
    let _guard = state
        .gs
        .write_lock
        .lock()
        .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
    let settings = workspace::read_global_settings(&state.gs.path);
    Ok(resolve_mode_from_preferences(
        &settings.user_preferences,
        fallback,
    ))
}

/// Linearization barrier for a native workspace replacement. The swap hook
/// waits for an old snapshot writer to finish, rotates the request generation,
/// and deactivates the shared pointer before any new writer can enter.
fn rotate_ime_workspace(state: &AppState) {
    let _writer = match state.ime_write_lock.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    state.ime_request_gate.rotate_workspace();
    if let Err(error) = set_active_project(&state.ime_root, None, ImeIntegrationMode::On) {
        eprintln!("failed to deactivate IME pointer during workspace swap: {error}");
    }
}

fn validate_ime_workspace(
    workspace: &ActiveWorkspaceSnapshot,
    expected_workspace_path: &str,
) -> std::result::Result<(), AppError> {
    let expected = PathBuf::from(expected_workspace_path);
    if workspace.path != expected {
        return Err(AppError::Anyhow(anyhow::anyhow!(
            "IME_WORKSPACE_CHANGED: expected {}, active {}",
            expected.display(),
            workspace.path.display()
        )));
    }
    Ok(())
}

/// Optimistically bind one request token to the exact DB/path snapshot seen at
/// IPC arrival. A concurrent swap either makes `active_workspace_snapshot`
/// fail closed or changes the gate generation so registration retries.
fn pin_ime_workspace_request(
    state: &AppState,
    expected_workspace_path: &str,
    mut register: impl FnMut(&ImeExportRequestGate, u64) -> Option<ImeExportRequestToken>,
) -> std::result::Result<(ActiveWorkspaceSnapshot, ImeExportRequestToken), AppError> {
    loop {
        let generation = state.ime_request_gate.workspace_generation();
        let workspace = active_workspace_snapshot(&state.ws)?;
        validate_ime_workspace(&workspace, expected_workspace_path)?;
        if let Some(request) = register(&state.ime_request_gate, generation) {
            return Ok((workspace, request));
        }
    }
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

/// チャット送信の 1 メッセージ (Tauri の `commands::ai::ChatMessagePayload` 相当)。
#[derive(serde::Deserialize)]
struct ChatMsgDto {
    role: String,
    content: String,
}

/// `send_chat_message` / `send_chat_message_stream` の FE 引数 (camelCase)。
/// Tauri コマンドの引数群と 1:1。**API キーは含まない** — キーは main プロセスの
/// safeStorage で解決した平文を別引数 `api_key` で注入する (Phase 3 バッチ3a)。
/// Option フィールドは serde が欠落を None として扱う (Tauri の Option 引数と同挙動)。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatRequest {
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
}

/// `send_inline_ai_stream` の FE 引数 (camelCase)。チャットと同じ message / reasoning
/// 形だが、prompt cache / web search は受けず、AI のべりすとでは Completion mode を使う。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct InlineAiRequest {
    messages: Vec<ChatMsgDto>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    model: Option<String>,
    api_variant: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
}

/// `send_agent_message` の FE 引数 (camelCase)。AgentMessage / AgentToolDef の
/// serde 定義を直接使い、toolUses / thinkingBlocks / inputSchema のワイヤをTauriと共有する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRequest {
    messages: Vec<grimodex_ai::AgentMessage>,
    tools: Vec<grimodex_ai::AgentToolDef>,
    thinking: Option<grimodex_ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    web_search: Option<grimodex_ai::WebSearchConfig>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<grimodex_ai::AiProvider>,
    endpoint_id: Option<String>,
}

/// `list_ai_models` の FE 引数。API キーは一覧取得では任意なので main が
/// safeStorage から取得できた値（未設定なら空文字）を別引数で注入する。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListAiModelsRequest {
    provider: grimodex_ai::AiProvider,
    endpoint_id: Option<String>,
}

/// `test_ai_connection` の FE 引数。接続先 provider/model は必須、variant / endpoint
/// は任意で、既知 endpoint だけを一時的に active へ切り替える。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestAiConnectionRequest {
    provider: grimodex_ai::AiProvider,
    model: String,
    api_variant: Option<String>,
    endpoint_id: Option<String>,
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
    pub fn new(app_data_dir: String, semantic_resource_root: Option<String>) -> Result<Backend> {
        // 旧 .node E2E / 外部callerとのconstructor互換を維持する。省略時はcwdや
        // build-time manifestへfallbackせず、必ず存在しないappData配下sentinelを使い、
        // Backend全体ではなくsemantic invokeだけをmodel missingで失敗させる。
        let semantic_resource_root = semantic_resource_root.unwrap_or_else(|| {
            PathBuf::from(&app_data_dir)
                .join("__missing_semantic_resources__")
                .to_string_lossy()
                .into_owned()
        });
        let state = AppState::new(&app_data_dir, &semantic_resource_root)
            .map_err(|e| Error::from_reason(format!("{e:#}")))?;
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

    // ─────────────────────── license (Phase 3e) ──────────────────────────

    /// Main-process-only bridge used during the Electron v2 first-run
    /// credential migration. This method is deliberately absent from
    /// `NAPI_COMMANDS`, so renderer IPC cannot request plaintext credentials.
    /// Feature-off development builds return a disabled envelope and never
    /// touch the OS keyring.
    #[napi]
    pub async fn read_legacy_api_keys_for_migration(&self) -> Result<String> {
        #[cfg(feature = "legacy-keyring-migration")]
        {
            let settings_path = self.state.ai_settings_path.clone();
            run_blocking(move || {
                let export = legacy_keyring::read_legacy_api_keys(&settings_path)?;
                Ok(serde_json::to_string(&export).map_err(anyhow::Error::from)?)
            })
            .await
        }

        #[cfg(not(feature = "legacy-keyring-migration"))]
        {
            Ok(r#"{"available":false,"entries":[]}"#.to_string())
        }
    }

    /// Main/CI-only build gate. Packaging verifies both release-only features
    /// before electron-builder runs; this method is not registered in renderer
    /// IPC and contains no user data.
    #[napi]
    pub async fn get_native_build_capabilities(&self) -> Result<String> {
        Ok(serde_json::json!({
            "licensing": cfg!(feature = "licensing"),
            "legacyKeyringMigration": cfg!(feature = "legacy-keyring-migration"),
        })
        .to_string())
    }

    /// 常時exportするライセンス状態IPC。feature無効buildでは共有crateが
    /// exact disabled DTOを返し、license.jsonには一切触れない。
    #[napi]
    pub async fn get_license_state(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        napi::tokio::task::spawn_blocking(move || {
            grimodex_license::get_license_state(&runtime)
                .and_then(|dto| serde_json::to_string(&dto).map_err(Into::into))
        })
        .await
        .map_err(join_err_to_napi)?
        .map_err(|error| Error::from_reason(format!("{error:#}")))
    }

    /// Polar activate → atomic license.json更新。HTTP await中にfile lockは保持しない。
    #[napi]
    pub async fn activate_license(&self, key: String) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::activate_license(&runtime, key)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 明示的な再検証。共有runtimeのsingle-flightとstale response guardを使う。
    #[napi]
    pub async fn revalidate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::revalidate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// Polar側を解除してから、同じactivationである場合だけlocal stateを破棄する。
    #[napi]
    pub async fn deactivate_license(&self) -> Result<String> {
        let runtime = Arc::clone(&self.state.license);
        let dto = grimodex_license::deactivate_license(&runtime)
            .await
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 起動5秒後/以後6時間周期のmain schedulerから呼ぶfail-soft cycle。
    /// disabled・not due・in-flightはJS null、実行後はJSON DTOを返す。
    #[napi]
    pub async fn run_license_validate_cycle(&self) -> Result<Option<String>> {
        let runtime = Arc::clone(&self.state.license);
        grimodex_license::run_validate_cycle(&runtime)
            .await
            .map(|dto| {
                serde_json::to_string(&dto).map_err(|error| Error::from_reason(error.to_string()))
            })
            .transpose()
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
    /// Tauri コマンドと同一経路。A3 相互運用の根拠)。swap直後hookで
    /// Codex matcher破棄 + semantic 4cache epoch rotateを行う。
    /// 完了時に `workspace:opened` (FE 購読者なしのデバッグチャネル) を emit
    /// する (§7.1 の end-to-end 実証チャネルその 2)。
    /// 返り値: `{"name":…,"isExisting":…}` の JSON 文字列。
    #[napi]
    pub async fn open_workspace(&self, path: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let state_for_hook = Arc::clone(&state);
            let mut on_swapped = move || {
                rotate_ime_workspace(&state_for_hook);
                let mut matcher = match state_for_hook.codex_matcher.lock() {
                    Ok(matcher) => matcher,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *matcher = None;
                state_for_hook.semantic.rotate_workspace_epoch();
            };
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

    /// Electron main専用の内部境界。standalone MCP sidecarへ渡す現在の
    /// workspace directoryを返す。renderer commandとしては公開せず、mainの
    /// `get_mcp_config` handlerだけが利用する。
    #[napi]
    pub async fn get_active_workspace_path(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let path = active_workspace_path(&state.ws)?;
            path.into_os_string().into_string().map_err(|_| {
                AppError::Anyhow(anyhow::anyhow!("Active workspace path is not valid UTF-8"))
            })
        })
        .await
    }

    /// アクティブworkspaceの復元候補を新しい順で返す。
    /// 返り値は `BackupInfo[]` のcamelCase JSON文字列。
    #[napi]
    pub async fn list_backups(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let backups = list_backups(&state.ws)?;
            Ok(serde_json::to_string(&backups).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// バックアップを検証・安全退避・原子置換し、同じworkspaceを再openする。
    /// 再open時にDB由来のCodex matcherを破棄し、semantic 4-cache epochも
    /// rotateして復元前DBへのlate writeを不可視にする。
    #[napi]
    pub async fn restore_backup(&self, file_name: String) -> Result<()> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let state_for_hook = Arc::clone(&state);
            restore_backup_core(&state.ws, &file_name, move || {
                rotate_ime_workspace(&state_for_hook);
                let mut matcher = match state_for_hook.codex_matcher.lock() {
                    Ok(matcher) => matcher,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *matcher = None;
                state_for_hook.semantic.rotate_workspace_epoch();
            })?;
            let path = active_workspace_path(&state.ws)?;
            state.events.emit(
                "workspace:opened",
                serde_json::json!({ "path": path, "reason": "restore" }),
            );
            Ok(())
        })
        .await
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

    /// AppData配下に一意なsample-workspace世代を共有coreで公開する。
    /// GlobalSettingsのwrite_lockをget/save/openと共有し、同時seedも同じ
    /// critical sectionへ入る。公開済み世代はアクティブDB/MCPが保持し得るため削除しない。
    #[napi]
    pub async fn seed_sample_workspace(
        &self,
        language: String,
        ai_policy: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let result = sample_seed::seed_sample_workspace(&state.gs, &language, &ai_policy)?;
            Ok(serde_json::to_string(&result).map_err(anyhow::Error::from)?)
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

    /// 現在の Codex 読みを `<userData>/ime/projects/<projectId>.json` へ再出力する。
    /// options は typed IPC と同じ camelCase `ImeExportOptions`。DB 読み取りと
    /// ファイル I/O の双方を Node main thread の外で実行する。
    #[napi]
    pub async fn ime_export_refresh(
        &self,
        project_id: String,
        expected_workspace_path: String,
        options: serde_json::Value,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let options: ImeExportOptions = from_wire("options", options).map_err(app_err_to_napi)?;
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_refresh_for_generation(&project_id, &options, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let options = authoritative_ime_options(&state, &options)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, options.mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = refresh_project_export(
                workspace.db.as_ref(),
                &state.ime_root,
                &project_id,
                &options,
            )?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// IME consumer が参照する active project を切り替える。`None` は明示的な
    /// deactivation であり、renderer からの null をそのまま受ける。
    #[napi]
    pub async fn ime_export_set_active_project(
        &self,
        project_id: Option<String>,
        expected_workspace_path: Option<String>,
        mode: String,
    ) -> Result<String> {
        let state = Arc::clone(&self.state);
        let mode: ImeIntegrationMode =
            from_wire("mode", serde_json::Value::String(mode)).map_err(app_err_to_napi)?;
        let request = if project_id.is_some() {
            let expected_workspace_path = expected_workspace_path.ok_or_else(|| {
                Error::from_reason(
                    "expectedWorkspacePath is required when activating an IME project",
                )
            })?;
            let (_, request) = pin_ime_workspace_request(
                &state,
                &expected_workspace_path,
                ImeExportRequestGate::register_active_for_generation,
            )
            .map_err(app_err_to_napi)?;
            request
        } else {
            state.ime_request_gate.register_active()
        };
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, mode)?;
            if !state.ime_request_gate.is_current(&request) {
                let status = get_ime_export_status(&state.ime_root, mode)?;
                return Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?);
            }
            let status = set_active_project(&state.ime_root, project_id.as_deref(), mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// Electron の will-quit 専用。blocking pool の処理をタイムアウトで
    /// 打ち切ると state.json が旧 project を指したまま終了し得るため、ここだけ
    /// 同期的に writer mutex を待ち、active pointer の解除完了を保証する。
    #[napi]
    pub fn ime_export_deactivate_on_exit(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_active();
        let _guard = state
            .ime_write_lock
            .lock()
            .map_err(|e| app_err_to_napi(AppError::Anyhow(anyhow::anyhow!("{e}"))))?;
        if !state.ime_request_gate.is_current(&request) {
            return Ok(());
        }
        set_active_project(&state.ime_root, None, ImeIntegrationMode::On)
            .map(|_| ())
            .map_err(|error| app_err_to_napi(AppError::Anyhow(error)))
    }

    /// consumer handshake と現在の export 状態を返す。
    #[napi]
    pub async fn ime_export_get_status(&self, mode: String) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let fallback: ImeIntegrationMode = from_wire("mode", serde_json::Value::String(mode))?;
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            let mode = authoritative_ime_mode(&state, fallback)?;
            let status = get_ime_export_status(&state.ime_root, mode)?;
            Ok(serde_json::to_string(&status).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// consumer handshake は保持し、project snapshots と active state を消去する。
    #[napi]
    pub async fn ime_export_clear_all(&self) -> Result<()> {
        let state = Arc::clone(&self.state);
        let request = state.ime_request_gate.register_clear();
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                return Ok(());
            }
            let result = clear_all_exports(&state.ime_root).map_err(AppError::from);
            state.ime_request_gate.finish_clear(&request);
            result
        })
        .await
    }

    /// 単一 project の snapshot を削除し、必要なら active state も解除する。
    #[napi]
    pub async fn ime_export_remove_project(
        &self,
        project_id: String,
        expected_workspace_path: String,
    ) -> Result<()> {
        let state = Arc::clone(&self.state);
        let (workspace, request) =
            pin_ime_workspace_request(&state, &expected_workspace_path, |gate, generation| {
                gate.register_remove_for_generation(&project_id, generation)
            })
            .map_err(app_err_to_napi)?;
        run_blocking(move || {
            let _guard = state
                .ime_write_lock
                .lock()
                .map_err(|e| AppError::Anyhow(anyhow::anyhow!("{e}")))?;
            if !state.ime_request_gate.is_current(&request) {
                if !state
                    .ime_request_gate
                    .is_workspace_generation_current(&request)
                {
                    return Err(AppError::Anyhow(anyhow::anyhow!(
                        "IME_WORKSPACE_CHANGED: snapshot cleanup must be retried"
                    )));
                }
                return Ok(());
            }
            remove_project_export_if_absent(workspace.db.as_ref(), &state.ime_root, &project_id)?;
            Ok(())
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
            let matcher =
                CachedMatcher::build(&entries).map_err(|e| Error::from_reason(format!("{e}")))?;
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

    /// 本文から未知の固有名詞候補を抽出する
    /// (`grimodex_semantic::codex_candidates` を Tauri と共用)。
    ///
    /// workspace DB は blocking pool へ投入する**前**に一度だけ pin する。これにより
    /// 待ち行列中に workspace が切り替わってもコマンド途中で別 DB を解決せず、開始時
    /// snapshot の scenes/known names を読む。共有コアは DB phase を単一 connection
    /// lock に閉じ、UniDic + Aho-Corasick の CPU phase は lock 外で実行する。
    /// 返り値: camelCase `CodexCandidate[]` の JSON 文字列。
    #[napi]
    pub async fn extract_codex_candidates(
        &self,
        project_id: String,
        min_count: Option<u32>,
    ) -> Result<String> {
        let db = grimodex_db::state::active_database(&self.state.ws).map_err(app_err_to_napi)?;
        let min_count = min_count.map(|value| value as usize);
        run_blocking(move || {
            let candidates = grimodex_semantic::codex_candidates::extract_codex_candidates(
                &db,
                &project_id,
                min_count,
            )?;
            Ok(serde_json::to_string(&candidates).map_err(anyhow::Error::from)?)
        })
        .await
    }

    // ─────────────────────── semantic Phase 3 Batch 4 ───────────────────
    // 全DB commandはrun_semantic_wireがinvoke開始時のDB Arc + 4cache epochを
    // 一貫pinする。各closureは共有runtimeだけを呼び、workspaceを再解決しない。

    /// モデルが無ければbackground downloadを開始し、状態文字列を即返す。
    /// resource欠落はBackend constructorを失敗させず、このsemantic surfaceでのみ
    /// installed/unavailable/downloading または明示エラーとして扱う。
    #[napi]
    pub async fn semantic_download_model(&self, language: String) -> Result<String> {
        let start = self
            .state
            .semantic
            .semantic_download_model(&language)
            .map_err(|error| Error::from_reason(format!("{error:#}")))?;
        let status = start.status().to_string();
        if let grimodex_semantic::runtime::ModelDownloadStart::Start(job) = start {
            napi::tokio::spawn(async move {
                // job自身が成功/失敗をdone eventへ載せ、Dropでinflightを必ず解除する。
                let _ = job.run().await;
            });
        }
        serde_json::to_string(&status).map_err(|error| Error::from_reason(error.to_string()))
    }

    #[napi]
    pub async fn semantic_index_scene(&self, scene_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_index_scene(request, &scene_id)
        })
        .await
    }

    #[napi]
    pub async fn semantic_search(
        &self,
        project_id: String,
        query: String,
        limit: u32,
        scene_scope: Option<String>,
        description_mode: Option<bool>,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_search(
                request,
                &project_id,
                &query,
                limit as usize,
                scene_scope.as_deref(),
                description_mode,
            )
        })
        .await
    }

    #[napi]
    pub async fn codex_index_entry(&self, entry_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_index_entry(request, &entry_id)
        })
        .await
    }

    #[napi]
    pub async fn codex_semantic_search(
        &self,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_semantic_search(request, &project_id, &query, limit as usize)
        })
        .await
    }

    #[napi]
    pub async fn codex_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn codex_reindex_all(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.codex_reindex_all(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn events_index_entry(&self, event_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_index_entry(request, &event_id)
        })
        .await
    }

    #[napi]
    pub async fn events_semantic_search(
        &self,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_semantic_search(request, &project_id, &query, limit as usize)
        })
        .await
    }

    #[napi]
    pub async fn events_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn events_reindex_all(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.events_reindex_all(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn chat_index_message(&self, message_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_index_message(request, &message_id)
        })
        .await
    }

    #[napi]
    pub async fn chat_message_search(
        &self,
        project_id: String,
        query: String,
        limit: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_message_search(request, &project_id, &query, limit as usize)
        })
        .await
    }

    #[napi]
    pub async fn chat_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn chat_reindex_all(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.chat_reindex_all(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn semantic_index_status(&self, project_id: String) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_index_status(request, &project_id)
        })
        .await
    }

    #[napi]
    pub async fn semantic_reindex_all(
        &self,
        project_id: String,
        run_id: Option<String>,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_reindex_all(request, &project_id, run_id.as_deref())
        })
        .await
    }

    #[napi]
    pub async fn semantic_chunk_context(
        &self,
        scene_id: String,
        char_start: u32,
        char_end: u32,
        padding: u32,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_chunk_context(
                request,
                &scene_id,
                char_start as usize,
                char_end as usize,
                padding as usize,
            )
        })
        .await
    }

    #[napi]
    pub async fn semantic_debug_dump(
        &self,
        project_id: String,
        scene_id: Option<String>,
        limit: Option<u32>,
    ) -> Result<String> {
        run_semantic_wire(Arc::clone(&self.state), move |runtime, request| {
            runtime.semantic_debug_dump(
                request,
                &project_id,
                scene_id.as_deref(),
                limit.map(|value| value as usize),
            )
        })
        .await
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
    pub async fn plot_thread_update(&self, id: String, patch: serde_json::Value) -> Result<String> {
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
    // Tauri の引数 deserialize と同一挙動で受ける。到達不能だった旧
    // foreshadow_list は両ランタイムから撤去済み。

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
                let v = post_effect::list_annotations_for_scene(db, project_id, scene_id, status)?;
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

    // ─────────────────────── post_effect runner (Phase 3d — shared Rust
    // engine + EventQueue 4ch + run_id単位abort registry) ─────────────────

    /// 単一sceneの校閲runを開始し、AI完了を待たず `{run_id,from_cache}` を返す。
    /// `settings` とsecretはElectron mainが同じinvokeで取得したsnapshot。API key
    /// 未登録 (`None`) と保存済み空文字 (`Some("")`) を区別し、lookup errorも
    /// cache hitを壊さないよう背景taskまで遅延させる。
    #[napi]
    pub async fn start_post_effect_run(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let args: grimodex_post_effect::StartPostEffectRunArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let runtime = NodePostEffectRuntime::new(Arc::clone(&self.state));
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error);
        let result = grimodex_post_effect::start_post_effect_run(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 複数sceneの校閲run。処理はscene境界でabort registryを確認し、イベントは
    /// `post_effect:{progress,partial,done,error}` をEventQueueへ配信する。
    #[napi]
    pub async fn start_post_effect_run_multi(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: Option<String>,
        api_key_error: Option<String>,
    ) -> Result<String> {
        let args: grimodex_post_effect::StartPostEffectRunMultiArgs =
            from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let runtime = NodePostEffectRuntime::new(Arc::clone(&self.state));
        let ai = NodePostEffectAiClient::new(settings, api_key, api_key_error);
        let result = grimodex_post_effect::start_post_effect_run_multi(runtime, ai, args)
            .await
            .map_err(app_err_to_napi)?;
        serde_json::to_string(&result).map_err(|error| Error::from_reason(error.to_string()))
    }

    /// 同一BackendのregistryとDB rowを一緒に更新する。DB上のproject ownershipを
    /// 確認できたrunning runだけにabort flagを立てるため、cross-project/late abort
    /// は別runや将来runへ波及しない。
    #[napi]
    pub async fn abort_post_effect_run(&self, run_id: String, project_id: String) -> Result<()> {
        let runtime = NodePostEffectRuntime::new(Arc::clone(&self.state));
        run_blocking(move || {
            grimodex_post_effect::abort_post_effect_run(&runtime, &run_id, &project_id)
        })
        .await
    }

    // ─────────────────────── AI チャット (Phase 3 バッチ3a — grimodex-ai を
    // Tauri と共用。HTTP/SSE/provider 分岐はクレート内で完結し、ストリーミングの
    // emit は EventQueue(=StreamEmitter) 経由で TSFn → 全窓 broadcast へ載る) ──
    //
    // **キーは注入**: Tauri の resolve_api_key(keyring) と異なり、napi は main の
    // safeStorage で解決した平文キーを `api_key` 引数で受ける。パラメータ準備
    // (apply_provider_override / build_chat_params 等) は Tauri と同一の pure helper。

    /// AI 設定を読む (Tauri の get_ai_settings と同一 — ai-settings.json、キー非含有)。
    /// 返り値: `AiSettings` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn get_ai_settings(&self) -> Result<String> {
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            let settings = grimodex_ai::read_ai_settings(&state.ai_settings_path);
            Ok(serde_json::to_string(&settings).map_err(anyhow::Error::from)?)
        })
        .await
    }

    /// AI 設定を `<appData>/ai-settings.json` へ保存する (Tauri の
    /// `save_ai_settings` と同一)。API キーは別の safeStorage 経路なので含まない。
    #[napi]
    pub async fn save_ai_settings(&self, settings: serde_json::Value) -> Result<()> {
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let state = Arc::clone(&self.state);
        run_blocking(move || {
            grimodex_ai::write_ai_settings(&state.ai_settings_path, &settings)?;
            Ok(())
        })
        .await
    }

    /// 非ストリーミングのチャット送信 (Tauri の send_chat_message と同一ロジック。
    /// キーは注入)。`args` は camelCase の ChatRequest、`api_key` は解決済み平文。
    /// `settings` は **呼び側 (dispatchInvoke) が getAiSettings で1回だけ読んだ AiSettings
    /// スナップショット** — キー解決と送信を同一スナップショットで行い、Tauri の
    /// 単一 read_ai_settings と同じ原子性を保つ (2 度読みの TOCTOU 回避)。
    /// 返り値: `ChatResponse` の JSON 文字列 (camelCase)。
    #[napi]
    pub async fn send_chat_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            None,
        );
        let msgs: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect();
        let result = grimodex_ai::send_chat(&params, &msgs)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// ストリーミングのチャット送信 (Tauri の send_chat_message_stream と同一)。
    /// チャンクは `chat:stream-chunk` / 完了は `chat:stream-done` を EventQueue へ emit。
    /// 失敗時は `chat:stream-error` を emit してから reject する (Tauri と同一契約 —
    /// FE の fire-and-forget .catch と listen error の両経路を保つ)。
    /// **abort は self.state.chat_abort を共有** — abort_chat_stream と同一インスタンス。
    #[napi]
    pub async fn send_chat_message_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: ChatRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        // 開始時に abort フラグをリセット (Tauri と同一 — 新ストリームは前回の中止要求を握り潰す)。
        self.state
            .chat_abort
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let flag = Arc::clone(&self.state.chat_abort);
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            None,
        );
        let msgs: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect();
        let result =
            grimodex_ai::send_chat_stream(&params, &msgs, flag, &self.state.events, "chat").await;
        if let Err(e) = result {
            EventSink::emit(
                &self.state.events,
                "chat:stream-error",
                serde_json::json!({ "message": e.to_string() }),
            );
            return Err(Error::from_reason(e.to_string()));
        }
        Ok(())
    }

    /// 実行中のチャットストリームを中止する (Tauri の abort_chat_stream と同一 —
    /// 純メモリの atomic store)。send_chat_message_stream と同一の chat_abort を立てる。
    #[napi]
    pub fn abort_chat_stream(&self) {
        self.state
            .chat_abort
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// インライン AI のストリーミング送信。`inline-ai:stream-*` へ emit し、
    /// AI のべりすとでは Completion mode を使う。チャットとは独立した abort flag。
    #[napi]
    pub async fn send_inline_ai_stream(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<()> {
        let req: InlineAiRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;

        self.state
            .inline_ai_abort
            .store(false, std::sync::atomic::Ordering::Relaxed);
        let flag = Arc::clone(&self.state.inline_ai_abort);
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        let effective_variant =
            grimodex_ai::inline_effective_variant(&settings_for_call, req.api_variant.as_deref());
        let variant = effective_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Completion,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            None,
            None,
            None,
        );
        let msgs: Vec<(&str, &str)> = req
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect();
        let result =
            grimodex_ai::send_chat_stream(&params, &msgs, flag, &self.state.events, "inline-ai")
                .await;
        if let Err(e) = result {
            EventSink::emit(
                &self.state.events,
                "inline-ai:stream-error",
                serde_json::json!({ "message": e.to_string() }),
            );
            return Err(Error::from_reason(e.to_string()));
        }
        Ok(())
    }

    /// 実行中のインライン AI ストリームを中止する。chat_abort とは独立。
    #[napi]
    pub fn abort_inline_ai_stream(&self) {
        self.state
            .inline_ai_abort
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// Tool Use 対応の Agent 送信。tool protocol 解決・Hermes/native の安全ゲートを
    /// 含む `grimodex_ai::send_chat_with_tools` をTauriと共用する。
    #[napi]
    pub async fn send_agent_message(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: AgentRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        let settings_for_call = grimodex_ai::apply_provider_override(
            settings,
            req.model.as_deref(),
            req.provider,
            req.endpoint_id.as_deref(),
        );
        let variant = req.api_variant.as_deref();
        let extra_body = grimodex_ai::build_ai_novelist_extra_body(&settings_for_call, variant);
        let retry_429 = grimodex_ai::should_retry_429(&settings_for_call);
        let resolved_variant =
            grimodex_ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
        let params = grimodex_ai::build_chat_params(
            &settings_for_call,
            &api_key,
            extra_body,
            retry_429,
            grimodex_ai::AiNovelistMode::Chat,
            resolved_variant,
            req.thinking,
            req.effort,
            req.reasoning_enabled,
            req.reasoning_effort,
            req.system_cache_segments,
            req.system_volatile_tail,
            req.web_search,
        );
        let result = grimodex_ai::send_chat_with_tools(&params, &req.messages, &req.tools)
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        serde_json::to_string(&result)
            .map_err(|e| Error::from_reason(format!("failed to serialize ChatResponse: {e}")))
    }

    /// provider のモデル一覧を取得する。`settings` はmainが1回読んだsnapshot、
    /// `api_key` はsafeStorageにキーが無い場合も空文字で注入される。
    #[napi]
    pub async fn list_ai_models(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: ListAiModelsRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        let models = grimodex_ai::fetch_models(&req.provider, &api_key, settings.endpoints())
            .await
            .map_err(|e| Error::from_reason(e.to_string()))?;
        serde_json::to_string(&models)
            .map_err(|e| Error::from_reason(format!("failed to serialize AI models: {e}")))
    }

    /// 最小リクエストでAI接続を確認する。variant解決はテスト対象providerを設定へ
    /// 反映してから行い、OpenAI互換endpointの既定variantを正しく選ぶ。
    #[napi]
    pub async fn test_ai_connection(
        &self,
        args: serde_json::Value,
        settings: serde_json::Value,
        api_key: String,
    ) -> Result<String> {
        let req: TestAiConnectionRequest = from_wire("args", args).map_err(app_err_to_napi)?;
        let mut settings: grimodex_ai::AiSettings =
            from_wire("settings", settings).map_err(app_err_to_napi)?;
        settings.provider = req.provider.clone();
        if let Some(endpoint_id) = req.endpoint_id.as_deref().filter(|id| !id.is_empty()) {
            if settings.has_openai_compatible_endpoint(endpoint_id) {
                settings.active_openai_compatible_endpoint_id = Some(endpoint_id.to_string());
            }
        }
        let variant =
            grimodex_ai::resolve_api_variant(req.api_variant.as_deref(), &settings, &req.model);
        grimodex_ai::test_connection(
            &req.provider,
            &req.model,
            &api_key,
            settings.endpoints(),
            variant.as_deref(),
        )
        .await
        .map_err(|e| Error::from_reason(e.to_string()))
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

#[cfg(test)]
mod ime_workspace_tests {
    use super::*;
    use grimodex_db::state::ActiveWorkspace;
    use grimodex_db::Database;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn workspace_rotation_waits_for_the_snapshot_writer_then_invalidates_it() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-workspace-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state = Arc::new(
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state"),
        );
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let old_request = state
            .ime_request_gate
            .register_refresh("default-project", &options);
        let writer = state.ime_write_lock.lock().expect("writer lock");
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let state_for_thread = Arc::clone(&state);
        let thread = std::thread::spawn(move || {
            started_tx.send(()).expect("started");
            rotate_ime_workspace(&state_for_thread);
            done_tx.send(()).expect("done");
        });

        started_rx.recv().expect("rotation started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(30)).is_err(),
            "rotation must not pass the writer barrier"
        );
        drop(writer);
        done_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("rotation completes after writer release");
        thread.join().expect("rotation thread");

        assert!(!state.ime_request_gate.is_current(&old_request));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn mismatched_workspace_path_does_not_invalidate_a_legitimate_request() {
        let dir = std::env::temp_dir().join(format!(
            "grimodex-node-ime-path-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default()
        ));
        let resources = dir.join("resources");
        let state =
            AppState::new(&dir.to_string_lossy(), &resources.to_string_lossy()).expect("app state");
        let workspace_path = dir.join("workspace-a");
        std::fs::create_dir_all(&workspace_path).expect("workspace dir");
        let db = Database::new(&workspace_path.join("grimodex.db")).expect("database");
        *state.ws.inner.lock().expect("workspace lock") = Some(ActiveWorkspace {
            db: Arc::new(db),
            path: workspace_path.clone(),
        });
        let options = ImeExportOptions {
            mode: ImeIntegrationMode::On,
            exclude_hidden: false,
            include_profile: true,
        };
        let legitimate = state
            .ime_request_gate
            .register_refresh("default-project", &options);

        let result = pin_ime_workspace_request(
            &state,
            &dir.join("workspace-b").to_string_lossy(),
            |gate, generation| {
                gate.register_refresh_for_generation("default-project", &options, generation)
            },
        );

        assert!(result.is_err());
        assert!(state.ime_request_gate.is_current(&legitimate));
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
