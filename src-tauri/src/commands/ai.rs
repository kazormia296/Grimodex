use std::sync::Arc;

use crate::ai;
use crate::openai_compat_presets;

use super::{AiSettingsPath, AppError, InlineAiAbortFlag, StreamAbortFlag};

/// API キーの解決ルール:
/// - Ollama: 不要（空文字）
/// - OpenaiCompatible: 任意（ローカル LLM サーバ等で API キー不要なケースを許容）
/// - Cli: 不要（CLI 側で認証管理。送信時はそもそもこのパスを通らない）
/// - その他: 必須（設定されていなければエラー）
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

/// プロバイダが OpenAI 互換のときだけプリセット ID を返す。それ以外は None。
/// `ChatParams.openai_compat_preset` に渡して、ainoverist 等の独自パスへの分岐に使う。
pub(super) fn openai_compat_preset_str(settings: &ai::AiSettings) -> Option<&str> {
    if matches!(settings.provider, ai::AiProvider::OpenaiCompatible) {
        Some(settings.openai_compatible.preset.as_str())
    } else {
        None
    }
}

/// 設定からプリセット由来のレート制限有無を判定し、429 リトライを有効化すべきか
/// を返す。プリセットがレート制限を公開していない場合は false。
pub(super) fn should_retry_429(settings: &ai::AiSettings) -> bool {
    if !matches!(settings.provider, ai::AiProvider::OpenaiCompatible) {
        return false;
    }
    openai_compat_presets::rate_limit_for(&settings.openai_compatible.preset, &settings.model)
        .is_some()
}

/// OpenAI 互換プロバイダのプリセット extra_body を構築する。
/// プリセットが許可するサンプリングキーだけを `settings.openai_compatible.sampling`
/// から抽出して JSON オブジェクトとして返す。プリセットが許可キーを持たない、
/// またはユーザーが値を設定していない場合は None。
pub(super) fn build_openai_compat_extra_body(
    settings: &ai::AiSettings,
) -> Option<serde_json::Value> {
    if !matches!(settings.provider, ai::AiProvider::OpenaiCompatible) {
        return None;
    }
    let allowed_keys =
        openai_compat_presets::extra_sampling_keys(&settings.openai_compatible.preset);
    if allowed_keys.is_empty() {
        return None;
    }
    let user_sampling = settings.openai_compatible.sampling.as_ref()?;
    let user_obj = user_sampling.as_object()?;
    let mut out = serde_json::Map::new();
    for key in allowed_keys {
        if let Some(v) = user_obj.get(*key) {
            // null や空文字は省略（誤送信防止）
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
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = build_openai_compat_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let preset = openai_compat_preset_str(&settings);
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
        openai_compat_preset: preset,
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
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let extra_body = build_openai_compat_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let preset = openai_compat_preset_str(&settings);
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
        openai_compat_preset: preset,
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
    let extra_body = build_openai_compat_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let preset = openai_compat_preset_str(&settings);
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
        openai_compat_preset: preset,
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
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(&settings.provider)?;
    let extra_body = build_openai_compat_extra_body(&settings);
    let retry_429 = should_retry_429(&settings);
    let preset = openai_compat_preset_str(&settings);
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
        openai_compat_preset: preset,
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
    // OpenaiCompatible の場合のみプリセット ID を渡す (ainoverist 等の独自パス分岐用)
    let preset = if matches!(&provider, ai::AiProvider::OpenaiCompatible) {
        Some(settings.openai_compatible.preset.as_str())
    } else {
        None
    };
    let result =
        ai::test_connection(&provider, &model, &api_key, settings.endpoints(), preset).await?;
    Ok(result)
}
