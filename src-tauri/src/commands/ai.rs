use std::sync::Arc;

use crate::ai;

use super::{AiSettingsPath, AppError, InlineAiAbortFlag, StreamAbortFlag};

/// API キーの解決ルール:
/// - Ollama: 不要（空文字）
/// - OpenaiCompatible: 任意（ローカル LLM サーバ等で API キー不要なケースを許容）
/// - Cli: 不要（CLI 側で認証管理。送信時はそもそもこのパスを通らない）
/// - その他 (AiNovelist 含む): 必須（設定されていなければエラー）
///
/// `endpoint_id` は OpenAI 互換プロバイダの per-endpoint キー解決でのみ意味を持つ
/// （その他のプロバイダでは無視され単一キーを引く）。
///
/// キー解決は Tauri 側だけの経路（OS keyring）。Electron（napi）側は main プロセスの
/// safeStorage で解決した平文キーを注入するため、この関数を通らない。パラメータ準備
/// （override 適用 / build_chat_params 等）は grimodex-ai の pure helper を Tauri/napi で
/// 共用する。
pub(super) fn resolve_api_key(
    provider: &ai::AiProvider,
    endpoint_id: Option<&str>,
) -> anyhow::Result<String> {
    if matches!(provider, ai::AiProvider::Ollama | ai::AiProvider::Cli) {
        return Ok(String::new());
    }
    if matches!(provider, ai::AiProvider::OpenaiCompatible) {
        return Ok(ai::get_api_key(provider, endpoint_id)?.unwrap_or_default());
    }
    ai::get_api_key(provider, None)?
        .ok_or_else(|| anyhow::anyhow!("No API key configured for {}", provider))
}

#[derive(serde::Deserialize)]
pub(crate) struct ChatMessagePayload {
    role: String,
    content: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_chat_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ChatMessagePayload>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    system_volatile_tail: Option<String>,
    // A/B 比較 (③): モデル override。None / 空文字なら設定の既定モデルを使う
    // （inline-ai と同一の解決規則）。後方互換: 既存呼び出しは省略可。
    model: Option<String>,
    // A/B 比較 (③): プロバイダ override。None なら設定の既定プロバイダを使う。
    // 別プロバイダの API キーは keyring に保存済み (get_api_key は任意 provider で
    // 解決可能) なので、グローバル設定を変えずに 1 ショットだけ別プロバイダへ投げられる。
    // 後方互換: 既存呼び出しは省略可。
    provider: Option<ai::AiProvider>,
    // OpenAI 互換: このメッセージだけ別エンドポイントへ向けるための override。
    // None なら設定の active エンドポイントを使う。provider!=互換 では無視される。
    endpoint_id: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    // provider/model/endpoint override を適用（chat / inline / agent 共通の pure helper）。
    let settings_for_call =
        ai::apply_provider_override(settings, model.as_deref(), provider, endpoint_id.as_deref());
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = ai::build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = ai::should_retry_429(&settings_for_call);
    let resolved_variant =
        ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
    let params = ai::build_chat_params(
        &settings_for_call,
        &api_key,
        extra_body,
        retry_429,
        ai::AiNovelistMode::Chat,
        resolved_variant,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        system_cache_segments,
        system_volatile_tail,
        None,
    );
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
    api_variant: Option<String>,
    system_volatile_tail: Option<String>,
    // A/B 比較 (③): モデル override。None / 空文字なら設定の既定モデルを使う。
    model: Option<String>,
    // Chat の別プロバイダ一時送信: プロバイダ override。None なら設定の既定プロバイダ。
    // send_chat_message と同一規則 — 別プロバイダの API キーは keyring から解決され、
    // グローバル設定を変えずにこの 1 ストリームだけ別プロバイダへ流せる。
    provider: Option<ai::AiProvider>,
    // OpenAI 互換: このストリームだけ別エンドポイントへ向ける override。
    // None なら設定の active エンドポイント。provider!=互換 では無視される。
    endpoint_id: Option<String>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let flag_clone = Arc::clone(&abort_flag.flag);
    let settings_for_call =
        ai::apply_provider_override(settings, model.as_deref(), provider, endpoint_id.as_deref());
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = ai::build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = ai::should_retry_429(&settings_for_call);
    let resolved_variant =
        ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
    let params = ai::build_chat_params(
        &settings_for_call,
        &api_key,
        extra_body,
        retry_429,
        ai::AiNovelistMode::Chat,
        resolved_variant,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        system_cache_segments,
        system_volatile_tail,
        None,
    );

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        &ai::TauriEmitter(app_handle.clone()),
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
    api_variant: Option<String>,
    // 機能別モデルのプロバイダ横断: provider override（None なら設定の既定プロバイダ）。
    // 別プロバイダのキーは keyring に保存済み。グローバル設定を変えずに送信先を切替える。
    provider: Option<ai::AiProvider>,
    // OpenAI 互換: このインライン生成だけ別エンドポイントへ向ける override。
    // None なら設定の active。provider!=互換 では無視される。
    endpoint_id: Option<String>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let flag_clone = Arc::clone(&abort_flag.flag);
    // provider/model/endpoint override を適用（pure helper・invariant b/c）。
    let settings_for_call =
        ai::apply_provider_override(settings, model.as_deref(), provider, endpoint_id.as_deref());
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    // openai-compatible は経路をエンドポイント単位の api_variant で決めるため
    // (resolve_api_variant 内で解決)、グローバル model_api_variant（Responses トグル）を
    // インライン AI 経路へ持ち込まない。持ち込むと /responses 非対応の互換サーバ(PlaMo 等)
    // へ漏れて 404 になる。provider override 時は上で model_api_variant=None 済み。
    let effective_variant =
        ai::inline_effective_variant(&settings_for_call, api_variant.as_deref());
    let variant = effective_variant.as_deref();
    let extra_body = ai::build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = ai::should_retry_429(&settings_for_call);
    let resolved_variant =
        ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
    let params = ai::build_chat_params(
        &settings_for_call,
        &api_key,
        extra_body,
        retry_429,
        ai::AiNovelistMode::Completion,
        resolved_variant,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        None,
        None,
        None,
    );

    let result = ai::send_chat_stream(
        &params,
        &messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        flag_clone,
        &ai::TauriEmitter(app_handle.clone()),
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
#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_agent_message(
    ai_path: tauri::State<'_, AiSettingsPath>,
    messages: Vec<ai::AgentMessage>,
    tools: Vec<ai::AgentToolDef>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    web_search: Option<ai::WebSearchConfig>,
    system_volatile_tail: Option<String>,
    // 機能別モデル: agent ロールの override。None / 空文字なら設定の既定モデルを
    // 使う（send_chat_message と同一の解決規則）。後方互換: 既存呼び出しは省略可。
    model: Option<String>,
    // Chat の別プロバイダ一時送信: プロバイダ override。None なら設定の既定プロバイダ。
    // send_chat_message と同一規則。
    provider: Option<ai::AiProvider>,
    // OpenAI 互換: この agent 送信だけ別エンドポイントへ向ける override。
    // None なら設定の active エンドポイント。provider!=互換 では無視される。
    endpoint_id: Option<String>,
) -> Result<ai::ChatResponse, AppError> {
    let settings = ai::read_ai_settings(&ai_path.path);
    let settings_for_call =
        ai::apply_provider_override(settings, model.as_deref(), provider, endpoint_id.as_deref());
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = ai::build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = ai::should_retry_429(&settings_for_call);
    let resolved_variant =
        ai::resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
    let params = ai::build_chat_params(
        &settings_for_call,
        &api_key,
        extra_body,
        retry_429,
        ai::AiNovelistMode::Chat,
        resolved_variant,
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        system_cache_segments,
        system_volatile_tail,
        web_search,
    );
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
pub(crate) fn save_api_key(
    provider: ai::AiProvider,
    key: String,
    // OpenAI 互換の per-endpoint キー。None なら従来の単一キー（または default）。
    endpoint_id: Option<String>,
) -> Result<(), AppError> {
    ai::save_api_key(&provider, endpoint_id.as_deref(), &key)?;
    Ok(())
}

/// キーの「有無」だけを返す。プレーンテキストのキーを renderer に渡さないことで、
/// 万一の renderer 侵害 (XSS) 時に最も価値の高い IPC exfil 標的を構造的に消す。
/// 実送信のキー解決は Rust 側 `resolve_api_key` が一手に担うため、フロントは
/// 設定済みかどうかの真偽値しか必要としない。
#[tauri::command]
pub(crate) fn has_api_key(
    provider: ai::AiProvider,
    endpoint_id: Option<String>,
) -> Result<bool, AppError> {
    Ok(ai::get_api_key(&provider, endpoint_id.as_deref())?.is_some())
}

#[tauri::command]
pub(crate) fn delete_api_key(
    provider: ai::AiProvider,
    endpoint_id: Option<String>,
) -> Result<(), AppError> {
    ai::delete_api_key(&provider, endpoint_id.as_deref())?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_ai_models(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
    // OpenAI 互換: モデル一覧を引く対象エンドポイント。None なら設定の active。
    endpoint_id: Option<String>,
) -> Result<Vec<ai::AiModel>, AppError> {
    let mut settings = ai::read_ai_settings(&ai_path.path);
    if let Some(eid) = endpoint_id.as_deref().filter(|s| !s.is_empty()) {
        // 未知 id は据え置き（別エンドポイントへの無言フォールバック防止）。
        if settings.has_openai_compatible_endpoint(eid) {
            settings.active_openai_compatible_endpoint_id = Some(eid.to_string());
        }
    }
    let api_key = ai::get_api_key(
        &provider,
        settings.active_openai_compatible_endpoint_id.as_deref(),
    )?
    .unwrap_or_default();
    let models = ai::fetch_models(&provider, &api_key, settings.endpoints()).await?;
    Ok(models)
}

#[tauri::command]
pub(crate) async fn test_ai_connection(
    ai_path: tauri::State<'_, AiSettingsPath>,
    provider: ai::AiProvider,
    model: String,
    api_variant: Option<String>,
    // OpenAI 互換: 接続テスト対象エンドポイント。None なら設定の active。
    endpoint_id: Option<String>,
) -> Result<String, AppError> {
    let mut settings = ai::read_ai_settings(&ai_path.path);
    // resolve_api_variant の endpoint-default 判定はテスト対象 provider 基準にする。
    settings.provider = provider.clone();
    if let Some(eid) = endpoint_id.as_deref().filter(|s| !s.is_empty()) {
        // 未知 id は据え置き（別エンドポイントへの無言フォールバック防止）。
        if settings.has_openai_compatible_endpoint(eid) {
            settings.active_openai_compatible_endpoint_id = Some(eid.to_string());
        }
    }
    let api_key = resolve_api_key(
        &provider,
        settings.active_openai_compatible_endpoint_id.as_deref(),
    )?;
    let variant = ai::resolve_api_variant(api_variant.as_deref(), &settings, &model);
    let result = ai::test_connection(
        &provider,
        &model,
        &api_key,
        settings.endpoints(),
        variant.as_deref(),
    )
    .await?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 回帰ガード: post_effect (校閲系 AI チェック) はこの関数でキーを解決する。
    // Ollama/Cli は keyring に触れず空文字を返すこと — get_api_key 直叩きに
    // 戻すと「API キーが設定されていません」でローカル LLM が全滅する。
    #[test]
    fn resolve_api_key_ollama_requires_no_key() {
        let key = resolve_api_key(&ai::AiProvider::Ollama, None).unwrap();
        assert_eq!(key, "");
    }

    #[test]
    fn resolve_api_key_cli_requires_no_key() {
        let key = resolve_api_key(&ai::AiProvider::Cli, None).unwrap();
        assert_eq!(key, "");
    }
}
