use std::sync::Arc;

use crate::ai;
use crate::ai_novelist;

use super::{AiSettingsPath, AppError, InlineAiAbortFlag, StreamAbortFlag};

/// API キーの解決ルール:
/// - Ollama: 不要（空文字）
/// - OpenaiCompatible: 任意（ローカル LLM サーバ等で API キー不要なケースを許容）
/// - Cli: 不要（CLI 側で認証管理。送信時はそもそもこのパスを通らない）
/// - その他 (AiNovelist 含む): 必須（設定されていなければエラー）
///
/// `endpoint_id` は OpenAI 互換プロバイダの per-endpoint キー解決でのみ意味を持つ
/// （その他のプロバイダでは無視され単一キーを引く）。
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

/// AI のべりすとプロバイダで 429 リトライを有効化すべきか判定する。
pub(super) fn should_retry_429(settings: &ai::AiSettings) -> bool {
    matches!(settings.provider, ai::AiProvider::AiNovelist)
}

/// AI のべりすと用 extra_body を構築する。
/// legacy: サンプリング + multilingualmode
/// v1: multilingual_mode のみ (サンプリングは legacy 専用)
pub(super) fn build_ai_novelist_extra_body(
    settings: &ai::AiSettings,
    api_variant: Option<&str>,
) -> Option<serde_json::Value> {
    if !matches!(settings.provider, ai::AiProvider::AiNovelist) {
        return None;
    }

    let is_v1 = api_variant == Some("v1");
    let mut out = serde_json::Map::new();

    if !is_v1 {
        if let Some(user_sampling) = settings.ai_novelist.sampling.as_ref() {
            if let Some(user_obj) = user_sampling.as_object() {
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
            }
        }
    }

    if settings.ai_novelist.multilingual_mode == Some(true) {
        if is_v1 {
            out.insert(
                "multilingual_mode".to_string(),
                serde_json::Value::Bool(true),
            );
        } else {
            out.insert(
                "multilingualmode".to_string(),
                serde_json::Value::Bool(true),
            );
        }
    }

    if out.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(out))
    }
}

#[allow(clippy::too_many_arguments)]
fn build_chat_params<'a>(
    settings: &'a ai::AiSettings,
    api_key: &'a str,
    extra_body: Option<serde_json::Value>,
    retry_429: bool,
    ai_novelist_mode: ai::AiNovelistMode,
    api_variant: Option<String>,
    thinking: Option<ai::ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    system_volatile_tail: Option<String>,
    web_search: Option<ai::WebSearchConfig>,
) -> ai::ChatParams<'a> {
    ai::ChatParams {
        provider: &settings.provider,
        model: &settings.model,
        api_key,
        endpoints: settings.endpoints(),
        thinking,
        effort,
        reasoning_enabled,
        reasoning_effort,
        extra_body,
        retry_429,
        ai_novelist_mode,
        openrouter_provider_pin: settings.openrouter_provider_pin.as_deref(),
        system_cache_segments,
        system_volatile_tail,
        api_variant,
        web_search,
        fusion: Some(&settings.fusion),
        resolved_tool_protocol: ai::resolve_tool_protocol(
            &settings.provider,
            &settings.model,
            settings.tool_protocol_mode,
        ),
    }
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
    let provider_overridden = provider.is_some();
    let effective_provider = provider.unwrap_or_else(|| settings.provider.clone());
    let resolved_model = model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model);
    let mut settings_for_call = settings.clone();
    settings_for_call.provider = effective_provider;
    settings_for_call.model = resolved_model.to_string();
    // provider override 時は、グローバルの model_api_variant (Responses トグル等は
    // 既定プロバイダ向けの設定) を別プロバイダへ持ち込まない。経路は明示の api_variant
    // か effective provider 既定の解決 (resolve_api_variant) に委ねる。
    if provider_overridden {
        settings_for_call.model_api_variant = None;
    }
    // OpenAI 互換エンドポイント override（指定時のみ上書き、未指定なら設定の active）。
    // 未知 id（例: 設定で削除済みのエンドポイントを指す stale な override）は黙って
    // 別サーバへ流さない — 既知の id のときだけ override し、それ以外は設定の active を据え置く。
    if let Some(eid) = endpoint_id.filter(|s| !s.is_empty()) {
        if settings_for_call.has_openai_compatible_endpoint(&eid) {
            settings_for_call.active_openai_compatible_endpoint_id = Some(eid);
        }
    }
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = should_retry_429(&settings_for_call);
    let resolved_variant = ai::resolve_api_variant(variant, &settings_for_call, resolved_model);
    let params = build_chat_params(
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
    let provider_overridden = provider.is_some();
    let effective_provider = provider.unwrap_or_else(|| settings.provider.clone());
    let flag_clone = Arc::clone(&abort_flag.flag);
    let resolved_model = model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model);
    let mut settings_for_call = settings.clone();
    settings_for_call.provider = effective_provider;
    settings_for_call.model = resolved_model.to_string();
    // provider override 時は、グローバルの model_api_variant (Responses トグル等は既定
    // プロバイダ向け) を別プロバイダへ持ち込まない。経路は明示 api_variant か
    // effective provider 既定の解決 (resolve_api_variant) に委ねる。
    if provider_overridden {
        settings_for_call.model_api_variant = None;
    }
    // OpenAI 互換エンドポイント override（指定時のみ上書き、未指定なら設定の active）。
    // 未知 id（例: 設定で削除済みのエンドポイントを指す stale な override）は黙って
    // 別サーバへ流さない — 既知の id のときだけ override し、それ以外は設定の active を据え置く。
    if let Some(eid) = endpoint_id.filter(|s| !s.is_empty()) {
        if settings_for_call.has_openai_compatible_endpoint(&eid) {
            settings_for_call.active_openai_compatible_endpoint_id = Some(eid);
        }
    }
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = should_retry_429(&settings_for_call);
    let resolved_variant = ai::resolve_api_variant(variant, &settings_for_call, resolved_model);
    let params = build_chat_params(
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
    api_variant: Option<String>,
) -> Result<(), AppError> {
    abort_flag
        .flag
        .store(false, std::sync::atomic::Ordering::Relaxed);

    let settings = ai::read_ai_settings(&ai_path.path);
    let api_key = resolve_api_key(
        &settings.provider,
        settings.active_openai_compatible_endpoint_id.as_deref(),
    )?;
    let flag_clone = Arc::clone(&abort_flag.flag);
    let resolved_model = model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model);
    // openai-compatible は経路をエンドポイント単位の api_variant で決めるため
    // (resolve_api_variant 内で解決)、グローバル model_api_variant（Responses トグル）を
    // インライン AI 経路へ持ち込まない。持ち込むと /responses 非対応の互換サーバ(PlaMo
    // 等)へ漏れて 404 になる。
    let global_variant = if matches!(settings.provider, ai::AiProvider::OpenaiCompatible) {
        None
    } else {
        settings.model_api_variant.as_deref()
    };
    let variant = api_variant.as_deref().or(global_variant);
    let mut settings_for_call = settings.clone();
    settings_for_call.model = resolved_model.to_string();
    let extra_body = build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = should_retry_429(&settings);
    let resolved_variant = ai::resolve_api_variant(variant, &settings_for_call, resolved_model);
    let params = build_chat_params(
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
    let provider_overridden = provider.is_some();
    let effective_provider = provider.unwrap_or_else(|| settings.provider.clone());
    let resolved_model = model
        .as_deref()
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model);
    let mut settings_for_call = settings.clone();
    settings_for_call.provider = effective_provider;
    settings_for_call.model = resolved_model.to_string();
    // provider override 時は、グローバルの model_api_variant を別プロバイダへ持ち込まない。
    if provider_overridden {
        settings_for_call.model_api_variant = None;
    }
    // OpenAI 互換エンドポイント override（指定時のみ上書き、未指定なら設定の active）。
    // 未知 id（例: 設定で削除済みのエンドポイントを指す stale な override）は黙って
    // 別サーバへ流さない — 既知の id のときだけ override し、それ以外は設定の active を据え置く。
    if let Some(eid) = endpoint_id.filter(|s| !s.is_empty()) {
        if settings_for_call.has_openai_compatible_endpoint(&eid) {
            settings_for_call.active_openai_compatible_endpoint_id = Some(eid);
        }
    }
    let api_key = resolve_api_key(
        &settings_for_call.provider,
        settings_for_call
            .active_openai_compatible_endpoint_id
            .as_deref(),
    )?;
    let variant = api_variant.as_deref();
    let extra_body = build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = should_retry_429(&settings_for_call);
    let resolved_variant = ai::resolve_api_variant(variant, &settings_for_call, resolved_model);
    let params = build_chat_params(
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

    #[test]
    fn build_ai_novelist_extra_body_v1_multilingual_mode() {
        let settings = ai::AiSettings {
            provider: ai::AiProvider::AiNovelist,
            ai_novelist: ai::AiNovelistSettings {
                multilingual_mode: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        let body = build_ai_novelist_extra_body(&settings, Some("v1")).unwrap();
        assert_eq!(body["multilingual_mode"], true);
        assert!(body.get("multilingualmode").is_none());
    }

    #[test]
    fn build_ai_novelist_extra_body_legacy_multilingualmode() {
        let settings = ai::AiSettings {
            provider: ai::AiProvider::AiNovelist,
            ai_novelist: ai::AiNovelistSettings {
                multilingual_mode: Some(true),
                ..Default::default()
            },
            ..Default::default()
        };
        let body = build_ai_novelist_extra_body(&settings, Some("legacy")).unwrap();
        assert_eq!(body["multilingualmode"], true);
        assert!(body.get("multilingual_mode").is_none());
    }

    #[test]
    fn build_ai_novelist_extra_body_v1_skips_sampling() {
        let settings = ai::AiSettings {
            provider: ai::AiProvider::AiNovelist,
            ai_novelist: ai::AiNovelistSettings {
                sampling: Some(serde_json::json!({ "rep_pen": 1.2 })),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(build_ai_novelist_extra_body(&settings, Some("v1")).is_none());
    }
}
