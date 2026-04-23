mod ai;
mod codex_matching;
mod database;
mod workspace;

use codex_matching::CodexMatcherState;
use database::Database;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::Manager;
use workspace::GlobalSettings;

/// AtomicBool flag to request aborting an in-progress stream.
struct StreamAbortFlag {
    flag: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Anyhow(#[from] anyhow::Error),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Serialize)]
struct QueryResult {
    rows: Vec<serde_json::Map<String, Value>>,
}

/// Holds the currently-open workspace's DB.
/// Wrapped in Option so it can be None before a workspace is opened.
struct ActiveWorkspace {
    db: Database,
    #[allow(dead_code)]
    path: PathBuf,
}

struct WorkspaceState {
    inner: Mutex<Option<ActiveWorkspace>>,
}

/// Path to the global settings file in AppData.
struct GlobalSettingsPath {
    path: PathBuf,
}

/// Path to the AI settings file in AppData.
struct AiSettingsPath {
    path: PathBuf,
}

// --- Workspace commands ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceResult {
    name: String,
    is_existing: bool,
}

#[tauri::command]
fn get_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
) -> Result<GlobalSettings, AppError> {
    Ok(workspace::read_global_settings(&gs_path.path))
}

#[tauri::command]
fn save_global_settings(
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    settings: GlobalSettings,
) -> Result<(), AppError> {
    workspace::write_global_settings(&gs_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
fn validate_workspace_path(path: String) -> bool {
    let p = PathBuf::from(&path);
    p.exists() && p.is_dir() && p.join("grimodex.db").exists()
}

#[tauri::command]
fn open_workspace(
    ws_state: tauri::State<'_, WorkspaceState>,
    gs_path: tauri::State<'_, GlobalSettingsPath>,
    path: String,
) -> Result<OpenWorkspaceResult, AppError> {
    let ws_path = PathBuf::from(&path);
    std::fs::create_dir_all(&ws_path).map_err(|e| anyhow::anyhow!(e))?;

    let is_existing = workspace::is_existing_workspace(&ws_path);

    // Initialize workspace metadata
    let uuid_str = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    workspace::ensure_workspace_meta(&ws_path, &uuid_str, &now)?;

    // Open database
    let db_path = ws_path.join("grimodex.db");
    let database = Database::new(&db_path)?;
    database.migrate()?;

    // Set as active workspace
    let mut inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    *inner = Some(ActiveWorkspace {
        db: database,
        path: ws_path,
    });

    // Update global settings
    let mut settings = workspace::read_global_settings(&gs_path.path);
    let now = chrono::Utc::now().to_rfc3339();
    workspace::touch_recent_workspace(&mut settings, &path, &now);
    workspace::write_global_settings(&gs_path.path, &settings)?;

    let name = workspace::workspace_name(&path);
    Ok(OpenWorkspaceResult { name, is_existing })
}

// --- Existing DB/content commands (now workspace-aware) ---

fn with_db<T>(
    ws_state: &tauri::State<'_, WorkspaceState>,
    f: impl FnOnce(&Database) -> anyhow::Result<T>,
) -> Result<T, AppError> {
    let inner = ws_state.inner.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
    let ws = inner
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("No workspace is open"))?;
    Ok(f(&ws.db)?)
}

#[tauri::command]
fn db_execute(
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

// --- FTS commands ---

#[tauri::command]
fn fts_optimize(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_optimize())
}

#[tauri::command]
fn fts_rebuild(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.fts_rebuild())
}

#[tauri::command]
fn fts_search(
    ws_state: tauri::State<'_, WorkspaceState>,
    project_id: String,
    query: String,
    scope: String,
    limit: u32,
) -> Result<Vec<Value>, AppError> {
    with_db(&ws_state, |db| {
        db.search_fts(&project_id, &query, &scope, limit)
    })
}

// --- Integrity commands ---

#[tauri::command]
fn integrity_check(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.integrity_check())
}

#[tauri::command]
fn repair_integrity(
    ws_state: tauri::State<'_, WorkspaceState>,
) -> Result<serde_json::Map<String, Value>, AppError> {
    with_db(&ws_state, |db| db.repair_integrity())
}

// --- Chat commands ---

/// Ollama はAPIキー不要のため空文字を返す。それ以外は設定済みキーを要求する。
fn resolve_api_key(provider: &ai::AiProvider) -> anyhow::Result<String> {
    if matches!(provider, ai::AiProvider::Ollama) {
        return Ok(String::new());
    }
    ai::get_api_key(provider)?
        .ok_or_else(|| anyhow::anyhow!("No API key configured for {}", provider))
}

#[derive(serde::Deserialize)]
struct ChatMessagePayload {
    role: String,
    content: String,
}

#[tauri::command]
async fn send_chat_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };
    let result = ai::send_chat(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
    )
    .await?;
    Ok(result)
}

// --- Stream abort command ---

#[tauri::command]
fn abort_chat_stream(abort_flag: tauri::State<'_, StreamAbortFlag>) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

// --- Streaming chat command ---

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn send_chat_message_stream(
    ai_path: tauri::State<'_, AiSettingsPath>,
    abort_flag: tauri::State<'_, StreamAbortFlag>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<(), AppError> {
    // Reset abort flag before starting
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        app_handle.clone(),
    )
    .await;

    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "chat:stream-error",
            serde_json::json!({ "message": e.to_string() }),
        );
        return Err(AppError::Anyhow(e));
    }

    Ok(())
}

// --- Agent / Tool Use command ---

#[tauri::command]
async fn send_agent_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ai::AgentMessage>,
    tools: Vec<ai::AgentToolDef>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        ollama_endpoint: &settings.ollama_endpoint,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
    };
    let result = ai::send_chat_with_tools(&params, &messages, &tools).await?;
    Ok(result)
}

// --- AI settings commands ---

#[tauri::command]
fn get_ai_settings(ai_path: tauri::State<'_, AiSettingsPath>) -> Result<ai::AiSettings, AppError> {
    Ok(ai::read_ai_settings(&ai_path.path))
}

#[tauri::command]
fn save_ai_settings(
    ai_path: tauri::State<'_, AiSettingsPath>,
    settings: ai::AiSettings,
) -> Result<(), AppError> {
    ai::write_ai_settings(&ai_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
fn save_api_key(provider: ai::AiProvider, key: String) -> Result<(), AppError> {
    ai::save_api_key(&provider, &key)?;
    Ok(())
}

#[tauri::command]
fn get_api_key(provider: ai::AiProvider) -> Result<Option<String>, AppError> {
    Ok(ai::get_api_key(&provider)?)
}

#[tauri::command]
fn delete_api_key(provider: ai::AiProvider) -> Result<(), AppError> {
    ai::delete_api_key(&provider)?;
    Ok(())
}

#[tauri::command]
async fn list_ai_models(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
) -> Result<Vec<ai::AiModel>, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = ai::get_api_key(&provider)?.unwrap_or_default();
    let models = ai::fetch_models(&provider, &api_key, &settings.ollama_endpoint).await?;
    Ok(models)
}

/// Deterministic text linter entry point (see `grimodex_lint::lint`).
///
/// Accepts the pre-serialised `LintBlock[]` from the frontend position map
/// and returns diagnostics in scene-wide UTF-16 offsets.
#[tauri::command]
fn lint_text(
    blocks: Vec<grimodex_lint::LintBlock>,
    language: String,
    scope: grimodex_lint::LintScope,
    config: grimodex_lint::LintConfig,
) -> Result<grimodex_lint::LintResponse, grimodex_lint::LintError> {
    let lang = match language.as_str() {
        "ja" => grimodex_lint::Language::Japanese,
        "en" => grimodex_lint::Language::English,
        other => return Err(grimodex_lint::LintError::InvalidLanguage(other.to_string())),
    };
    grimodex_lint::lint(&blocks, lang, scope, &config)
}

#[tauri::command]
async fn test_ai_connection(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
    model: String,
) -> Result<String, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&provider)?;
    let result =
        ai::test_connection(&provider, &model, &api_key, &settings.ollama_endpoint).await?;
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app
                .path()
                .app_data_dir()
                .expect("failed to get app data dir");
            std::fs::create_dir_all(&app_dir).ok();

            // Global settings path (stays in AppData)
            let gs_path = app_dir.join("global-settings.json");
            app.manage(GlobalSettingsPath { path: gs_path });

            // AI settings path (stays in AppData)
            let ai_path = app_dir.join("ai-settings.json");
            app.manage(AiSettingsPath { path: ai_path });

            // Workspace state starts empty — frontend will call open_workspace
            app.manage(WorkspaceState {
                inner: Mutex::new(None),
            });

            // Codex matcher state (rebuilt on demand via codex_rebuild_matcher)
            app.manage(CodexMatcherState {
                inner: Mutex::new(None),
            });

            // Stream abort flag
            app.manage(StreamAbortFlag {
                flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_global_settings,
            save_global_settings,
            validate_workspace_path,
            open_workspace,
            db_execute,
            get_ai_settings,
            save_ai_settings,
            save_api_key,
            get_api_key,
            delete_api_key,
            list_ai_models,
            test_ai_connection,
            send_chat_message,
            send_chat_message_stream,
            abort_chat_stream,
            send_agent_message,
            fts_optimize,
            fts_rebuild,
            fts_search,
            integrity_check,
            repair_integrity,
            codex_matching::codex_rebuild_matcher,
            codex_matching::codex_match_text,
            lint_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
