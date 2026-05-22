use std::sync::Arc;

use crate::ai;
use crate::ai_novelist;

use super::{AiSettingsPath, AppError, InlineAiAbortFlag, StreamAbortFlag};

/// API キーの解決ルール:
/// - Ollama: 不要（空文字）
/// - OpenaiCompatible: 任意（ローカル LLM サーバ等で API キー不要なケースを許容）
/// - Cli: 不要（CLI 側で認証管理。送信時はそもそもこのパスを通らない）
/// - その他 (AiNovelist 含む): 必須（設定されていなければエラー）
pub(super) fn resolve_api_key(provider: &ai::AiProvider) -> anyhow::Result<String> {
    if matches!(provider, ai::AiProvider::Ollama | ai::AiProvider::Cli) {
        return Ok(String::new());
    }
    if matches!(provider, ai::AiProvider::OpenaiCompatible) {
        return Ok(ai::get_api_key(provider)?.unwrap_or_default());
    }
    ai::get_api_key(provider)?
        .ok_or_else(|| anyhow::anyhow!("No API key configured for {}", provider))
}

/// AI のべりすとプロバイダで 429 リトライを有効化すべきか判定する。
pub(super) fn should_retry_429(settings: &ai::AiSettings) -> bool {
    matches!(settings.provider, ai::AiProvider::AiNovelist)
}

/// AI のべりすと用 extra_body を構築する。
/// `EXTRA_SAMPLING_KEYS` で許可されたキーだけを `settings.ai_novelist.sampling`
/// から抽出して返す。値が無い / 全て空なら None。
pub(super) fn build_ai_novelist_extra_body(settings: &ai::AiSettings) -> Option<serde_json::Value> {
    if !matches!(settings.provider, ai::AiProvider::AiNovelist) {
        return None;
    }
    let user_sampling = settings.ai_novelist.sampling.as_ref()?;
    let user_obj = user_sampling.as_object()?;
    let mut out = serde_json::Map::new();
    for key in ai_novelist::EXTRA_SAMPLING_KEYS {
        if let Some(v) = user_obj.get(*key) {
            if v.is_null() {
                continue;
            }
            if let Some(s) = v.as_str() {
                if s.is_empty() {
                    continue;
                }
            }
            out.insert((*key).to_string(), v.clone());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(out))
    }
}

#[derive(serde::Deserialize)]
pub(crate) struct ChatMessagePayload {
    role: String,
    content: String,
}

#[tauri::command]
pub(crate) async fn send_chat_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = build_ai_novelist_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Chat,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments,
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

#[tauri::command]
pub(crate) fn abort_chat_stream(
    abort_flag: tauri::State<'_, StreamAbortFlag>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_chat_message_stream(
    ai_path: tauri::State<'_, AiSettingsPath>,
    abort_flag: tauri::State<'_, StreamAbortFlag>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let extra_body = build_ai_novelist_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Chat,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments,
    };

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        app_handle.clone(),
        "chat",
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

#[tauri::command]
pub(crate) fn abort_inline_ai_stream(
    abort_flag: tauri::State<'_, InlineAiAbortFlag>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_inline_ai_stream(
    ai_path: tauri::State<'_, AiSettingsPath>,
    abort_flag: tauri::State<'_, InlineAiAbortFlag>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    model: Option<String>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let resolved_model = model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model);
    let extra_body = build_ai_novelist_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: resolved_model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Completion,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments: None,
    };

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        app_handle.clone(),
        "inline-ai",
    )
    .await;

    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app_handle.emit(
            "inline-ai:stream-error",
            serde_json::json!({ "message": e.to_string() }),
        );
        return Err(AppError::Anyhow(e));
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn send_agent_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ai::AgentMessage>,
    tools: Vec<ai::AgentToolDef>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = build_ai_novelist_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let params = ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key: &api_key,
        endpoints: settings.endpoints(),
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        extra_body,
        retry_429,
        ai_novelist_mode: ai::AiNovelistMode::Chat,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments,
    };
    let result = ai::send_chat_with_tools(&params, &messages, &tools).await?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn get_ai_settings(
    ai_path: tauri::State<'_, AiSettingsPath>,
) -> Result<ai::AiSettings, AppError> {
    Ok(ai::read_ai_settings(&ai_path.path))
}

#[tauri::command]
pub(crate) fn save_ai_settings(
    ai_path: tauri::State<'_, AiSettingsPath>,
    settings: ai::AiSettings,
) -> Result<(), AppError> {
    ai::write_ai_settings(&ai_path.path, &settings)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn save_api_key(provider: ai::AiProvider, key: String) -> Result<(), AppError> {
    ai::save_api_key(&provider, &key)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn get_api_key(provider: ai::AiProvider) -> Result<Option<String>, AppError> {
    Ok(ai::get_api_key(&provider)?)
}

#[tauri::command]
pub(crate) fn delete_api_key(provider: ai::AiProvider) -> Result<(), AppError> {
    ai::delete_api_key(&provider)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_ai_models(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
) -> Result<Vec<ai::AiModel>, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = ai::get_api_key(&provider)?.unwrap_or_default();
    let models = ai::fetch_models(&provider, &api_key, settings.endpoints()).await?;
    Ok(models)
}

#[tauri::command]
pub(crate) async fn test_ai_connection(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
    model: String,
) -> Result<String, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&provider)?;
    let result = ai::test_connection(&provider, &model, &api_key, settings.endpoints()).await?;
    Ok(result)
}
