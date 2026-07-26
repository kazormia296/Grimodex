//! チャット送信パラメータの組み立て（provider/model/endpoint override 適用、
//! extra_body 構築、ChatParams 生成）。Tauri コマンド層と napi バックエンドが
//! **同一のパラメータ準備ロジック**を共有するための pure helper 群
//! （Electron 移行 Phase 3 バッチ3a で commands/ai.rs から抽出）。
//!
//! キーの解決だけは経路が異なる（Tauri = keyring / napi = safeStorage で解決した
//! 平文キーを注入）ため、各ラッパが解決済みキーを `build_chat_params` に渡す。

use crate::{AiNovelistMode, AiProvider, AiSettings, ChatParams, ThinkingConfig, WebSearchConfig};

/// provider/model/endpoint override を AiSettings へ適用する（chat / inline / agent
/// 共通）。send_chat_message / send_inline_ai_stream / send_agent_message の本体に
/// inline していた変換と byte-identical:
///   - provider を effective_provider（override 無しなら設定の既定）に差し替え
///   - model を resolved_model（override 無し or 空なら設定の既定）に差し替え
///   - provider override 時はグローバル model_api_variant を別プロバイダへ持ち込まない（=None）
///   - openai-compatible エンドポイント override は既知 id のときだけ active を切替え、
///     未知 id は active 据え置き（別サーバへの無言リターゲット防止）
pub fn apply_provider_override(
    settings: AiSettings,
    model: Option<&str>,
    provider: Option<AiProvider>,
    endpoint_id: Option<&str>,
) -> AiSettings {
    let provider_overridden = provider.is_some();
    let effective_provider = provider.unwrap_or_else(|| settings.provider.clone());
    let resolved_model = model
        .filter(|m| !m.is_empty())
        .unwrap_or(&settings.model)
        .to_string();
    let mut settings_for_call = settings;
    settings_for_call.provider = effective_provider;
    settings_for_call.model = resolved_model;
    if provider_overridden {
        settings_for_call.model_api_variant = None;
    }
    if let Some(eid) = endpoint_id.filter(|s| !s.is_empty()) {
        if settings_for_call.has_openai_compatible_endpoint(eid) {
            settings_for_call.active_openai_compatible_endpoint_id = Some(eid.to_string());
        }
    }
    settings_for_call
}

/// インライン AI 経路で実際に送る API 経路 variant を解決する。
/// openai-compatible はエンドポイント単位の api_variant で経路を決めるため
/// （resolve_api_variant 内で解決）、グローバル model_api_variant（Responses トグル）を
/// 持ち込まない。持ち込むと /responses 非対応の互換サーバ(PlaMo 等)へ漏れて 404 になる。
/// per-call の `api_variant` が最優先で、無いときだけ上記ルールの global_variant に落ちる。
pub fn inline_effective_variant(
    settings: &AiSettings,
    api_variant: Option<&str>,
) -> Option<String> {
    let global_variant = if matches!(settings.provider, AiProvider::OpenaiCompatible) {
        None
    } else {
        settings.model_api_variant.as_deref()
    };
    api_variant.or(global_variant).map(|s| s.to_string())
}

/// AI のべりすとプロバイダで 429 リトライを有効化すべきか判定する。
pub fn should_retry_429(settings: &AiSettings) -> bool {
    matches!(settings.provider, AiProvider::AiNovelist)
}

/// AI のべりすと用 extra_body を構築する。
/// legacy: サンプリング + multilingualmode
/// v1: multilingual_mode のみ (サンプリングは legacy 専用)
pub fn build_ai_novelist_extra_body(
    settings: &AiSettings,
    api_variant: Option<&str>,
) -> Option<serde_json::Value> {
    if !matches!(settings.provider, AiProvider::AiNovelist) {
        return None;
    }

    let is_v1 = api_variant == Some("v1");
    let mut out = serde_json::Map::new();

    if !is_v1 {
        if let Some(user_sampling) = settings.ai_novelist.sampling.as_ref() {
            if let Some(user_obj) = user_sampling.as_object() {
                for key in crate::ai_novelist::EXTRA_SAMPLING_KEYS {
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

/// 解決済みの設定・API キーから `ChatParams` を組み立てる。
/// キーは呼び出し側で解決済み（Tauri=keyring / napi=safeStorage 注入）。
#[allow(clippy::too_many_arguments)]
pub fn build_chat_params<'a>(
    settings: &'a AiSettings,
    api_key: &'a str,
    extra_body: Option<serde_json::Value>,
    retry_429: bool,
    ai_novelist_mode: AiNovelistMode,
    api_variant: Option<String>,
    thinking: Option<ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    system_volatile_tail: Option<String>,
    web_search: Option<WebSearchConfig>,
) -> ChatParams<'a> {
    ChatParams {
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
        request_max_output_tokens: None,
        api_variant,
        web_search,
        fusion: Some(&settings.fusion),
        resolved_tool_protocol: crate::resolve_tool_protocol(
            &settings.provider,
            &settings.model,
            settings.tool_protocol_mode,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AiNovelistSettings, OpenaiCompatibleEndpoint};

    #[test]
    fn build_ai_novelist_extra_body_v1_multilingual_mode() {
        let settings = AiSettings {
            provider: AiProvider::AiNovelist,
            ai_novelist: AiNovelistSettings {
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
        let settings = AiSettings {
            provider: AiProvider::AiNovelist,
            ai_novelist: AiNovelistSettings {
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
        let settings = AiSettings {
            provider: AiProvider::AiNovelist,
            ai_novelist: AiNovelistSettings {
                sampling: Some(serde_json::json!({ "rep_pen": 1.2 })),
                ..Default::default()
            },
            ..Default::default()
        };
        assert!(build_ai_novelist_extra_body(&settings, Some("v1")).is_none());
    }

    fn compat_settings_with_endpoints() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenaiCompatible,
            model: "base-model".into(),
            active_openai_compatible_endpoint_id: Some("default".into()),
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: "default".into(),
                    base_url: "http://default/v1".into(),
                    ..Default::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "other".into(),
                    base_url: "http://other/v1".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    // invariant b: provider override 時はグローバル model_api_variant を
    // 別プロバイダへ持ち込まない（None にクリア）。
    #[test]
    fn provider_override_clears_model_api_variant() {
        let mut input = AiSettings {
            provider: AiProvider::OpenAI,
            ..Default::default()
        };
        input.model_api_variant = Some("responses".into());

        let out = apply_provider_override(input, None, Some(AiProvider::OpenaiCompatible), None);

        assert_eq!(out.provider, AiProvider::OpenaiCompatible);
        assert_eq!(out.model_api_variant, None);
    }

    // invariant c（負例・セキュリティ）: 未知エンドポイント id は active を据え置く。
    #[test]
    fn unknown_endpoint_leaves_active_unchanged() {
        let input = compat_settings_with_endpoints();
        let out = apply_provider_override(input, None, None, Some("does-not-exist"));
        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            Some("default".into())
        );
    }

    // invariant c（正例）: 既知エンドポイント id は active を切替える。
    #[test]
    fn known_endpoint_switches_active() {
        let input = compat_settings_with_endpoints();
        let out = apply_provider_override(input, None, None, Some("other"));
        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            Some("other".into())
        );
    }

    // all-None override: provider/model は設定から解決され、
    // model_api_variant は触られない（後方互換）。
    #[test]
    fn all_none_resolves_from_settings() {
        let mut input = AiSettings {
            provider: AiProvider::OpenAI,
            model: "settings-model".into(),
            ..Default::default()
        };
        input.model_api_variant = Some("responses".into());

        let out = apply_provider_override(input.clone(), None, None, None);

        assert_eq!(out.provider, AiProvider::OpenAI);
        assert_eq!(out.model, "settings-model");
        assert_eq!(out.model_api_variant, Some("responses".into()));
        assert_eq!(
            out.active_openai_compatible_endpoint_id,
            input.active_openai_compatible_endpoint_id
        );
    }

    // 空文字 model override は設定の既定 model を据え置く（filter(!is_empty) 契約）。
    #[test]
    fn empty_model_override_keeps_settings_model() {
        let input = AiSettings {
            provider: AiProvider::OpenAI,
            model: "settings-model".into(),
            ..Default::default()
        };
        let out = apply_provider_override(input, Some(""), None, None);
        assert_eq!(out.model, "settings-model");
    }

    // inline_effective_variant: openai-compatible は per-call variant 無しなら
    // グローバル model_api_variant=Some("responses") でも None を返す
    // （/responses 非対応の互換サーバへ Responses トグルを漏らさない・PlaMo-404 防止）。
    #[test]
    fn inline_variant_openai_compatible_suppresses_global_responses() {
        let mut settings = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            ..Default::default()
        };
        settings.model_api_variant = Some("responses".into());
        assert_eq!(inline_effective_variant(&settings, None), None);
    }

    // inline_effective_variant: 非互換 provider はグローバル variant を素通しする。
    #[test]
    fn inline_variant_non_compatible_passes_global_through() {
        let mut settings = AiSettings {
            provider: AiProvider::OpenAI,
            ..Default::default()
        };
        settings.model_api_variant = Some("responses".into());
        assert_eq!(
            inline_effective_variant(&settings, None),
            Some("responses".into())
        );
    }

    // inline_effective_variant: per-call api_variant が最優先（互換でも勝つ）。
    #[test]
    fn inline_variant_per_call_overrides_global() {
        let mut settings = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            ..Default::default()
        };
        settings.model_api_variant = Some("responses".into());
        assert_eq!(
            inline_effective_variant(&settings, Some("v1")),
            Some("v1".into())
        );
    }
}
