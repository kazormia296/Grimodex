use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

use crate::ai_novelist;

/// Supported AI providers.
///
/// - `OpenaiCompatible` はユーザーが任意の OpenAI 互換エンドポイント
///   (llama.cpp / LM Studio / vLLM / 自前ホスト等) を `baseURL` で指定する
///   プロバイダ。`AiSettings.openai_compatible.base_url` を参照する。
/// - `AiNovelist` は AI のべりすと専用プロバイダ。レガシー `/api` (独自フォーマット)
///   と v1 `/v1` (OpenAI 互換) を `api_variant` で切り替える。
/// - `Cli` はローカルにインストール済みの CLI エージェント (Claude Code 等) を
///   subprocess で起動するプロバイダ。HTTP 系の `send_chat*` には流れず、
///   `commands/cli_ai.rs` の専用ハンドラで処理される。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AiProvider {
    #[serde(rename = "openrouter")]
    OpenRouter,
    #[serde(rename = "openai")]
    OpenAI,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "openai-compatible")]
    OpenaiCompatible,
    /// Sakana AI (fugu / fugu-ultra)。固定 base URL の OpenAI 互換 frontier プロバイダで、
    /// `/responses` (Responses API) を推奨経路として公開する。
    #[serde(rename = "sakana")]
    Sakana,
    #[serde(rename = "ai-novelist")]
    AiNovelist,
    #[serde(rename = "cli")]
    Cli,
}

/// Agent ループでツール呼び出しを授受するプロトコル（ユーザー設定値）。
/// `auto` は HTTP OpenAI 互換プロバイダで model 名に `hermes` を含む場合のみ Hermes。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ToolProtocolMode {
    #[default]
    Auto,
    Native,
    Hermes,
}

/// 解決後のツールプロトコル（曖昧さを排した二値）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResolvedToolProtocol {
    Native,
    Hermes,
}

/// provider / model / mode からツールプロトコルを解決する。
/// TS [`resolveToolProtocol`](src/features/chat/toolProtocolParse.ts) と同一論理。
/// provider ゲート最優先（HTTP OpenAI 互換以外は常に Native）、auto は model 名に
/// `hermes` を含む場合のみ Hermes（qwen 等は対象外）。
pub fn resolve_tool_protocol(
    provider: &AiProvider,
    model: &str,
    mode: ToolProtocolMode,
) -> ResolvedToolProtocol {
    // HTTP OpenAI 互換プロバイダのみ Hermes 解決の対象。
    let http_openai_compat = matches!(
        provider,
        AiProvider::OpenRouter
            | AiProvider::OpenAI
            | AiProvider::Ollama
            | AiProvider::OpenaiCompatible
            | AiProvider::Sakana
            | AiProvider::AiNovelist
    );
    if !http_openai_compat {
        return ResolvedToolProtocol::Native;
    }
    match mode {
        ToolProtocolMode::Native => ResolvedToolProtocol::Native,
        ToolProtocolMode::Hermes => ResolvedToolProtocol::Hermes,
        ToolProtocolMode::Auto => {
            if model.to_lowercase().contains("hermes") {
                ResolvedToolProtocol::Hermes
            } else {
                ResolvedToolProtocol::Native
            }
        }
    }
}

/// native tool_calls 経路で mutating ツール（`HERMES_BLOCKED_TOOL_NAMES`）を破棄
/// すべき低信頼プロバイダ。間接プロンプトインジェクションで弱い local 小型モデルが
/// native tool_call を捏造 emit するケースを構造的に遮断する（Hermes 本文経路と対称）。
/// TS `isRagCapableProvider`（openrouter/anthropic のみ信頼）の補集合のうち local/未検証
/// な OpenAI 互換系に限定し、frontier（OpenRouter/OpenAI native）は除外して正規の
/// agent 書き込みを維持する。
pub(crate) fn is_low_trust_native_provider(p: &AiProvider) -> bool {
    matches!(
        p,
        AiProvider::Ollama | AiProvider::OpenaiCompatible | AiProvider::AiNovelist
    )
}

/// プロバイダごとに参照するユーザー設定 URL を集約する。
/// Ollama は `ollama_endpoint`、OpenaiCompatible は `openai_compat_custom` を使う。
/// それ以外のプロバイダは固定 URL でこの値を参照しない。
#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderEndpoints<'a> {
    pub ollama: &'a str,
    pub openai_compat_custom: &'a str,
}

impl<'a> ProviderEndpoints<'a> {
    #[cfg(test)]
    pub fn new(ollama: &'a str, openai_compat_custom: &'a str) -> Self {
        Self {
            ollama,
            openai_compat_custom,
        }
    }
}

impl AiProvider {
    /// Keyring service name for this provider.
    /// Cli プロバイダは API キーを使わないが、enum 整合のため名前は持たせる。
    fn keyring_service(&self) -> &str {
        match self {
            AiProvider::OpenRouter => "grimodex-openrouter",
            AiProvider::OpenAI => "grimodex-openai",
            AiProvider::Anthropic => "grimodex-anthropic",
            AiProvider::Ollama => "grimodex-ollama",
            AiProvider::OpenaiCompatible => "grimodex-openai-compatible",
            AiProvider::Sakana => "grimodex-sakana",
            AiProvider::AiNovelist => "grimodex-ai-novelist",
            AiProvider::Cli => "grimodex-cli", // 実質未使用 (CLI 側で認証管理)
        }
    }

    /// Base URL for API requests.
    /// Cli は HTTP 経路を持たないので空文字を返す (呼び出し側はそもそもこの値を
    /// 使わず、`commands/cli_ai.rs` 経由で subprocess 起動する)。
    pub fn base_url(&self, ep: ProviderEndpoints<'_>) -> String {
        match self {
            AiProvider::OpenRouter => "https://openrouter.ai/api/v1".to_string(),
            AiProvider::OpenAI => "https://api.openai.com/v1".to_string(),
            AiProvider::Anthropic => "https://api.anthropic.com/v1".to_string(),
            AiProvider::Ollama => format!("{}/api", ep.ollama.trim_end_matches('/')),
            AiProvider::OpenaiCompatible => {
                ep.openai_compat_custom.trim_end_matches('/').to_string()
            }
            AiProvider::Sakana => "https://api.sakana.ai/v1".to_string(),
            AiProvider::AiNovelist => ai_novelist::BASE_URL.to_string(),
            AiProvider::Cli => String::new(),
        }
    }

    /// OpenAI-compatible base URL (used for chat/completions).
    /// Ollama exposes the OpenAI-compatible API at /v1, not /api.
    pub fn openai_compat_base_url(
        &self,
        ep: ProviderEndpoints<'_>,
        api_variant: Option<&str>,
    ) -> String {
        match self {
            AiProvider::Ollama => format!("{}/v1", ep.ollama.trim_end_matches('/')),
            AiProvider::AiNovelist if api_variant == Some("v1") => {
                ai_novelist::V1_BASE_URL.to_string()
            }
            _ => self.base_url(ep),
        }
    }

    /// Models endpoint URL.
    pub fn models_url(&self, ep: ProviderEndpoints<'_>, api_variant: Option<&str>) -> String {
        match self {
            AiProvider::OpenRouter => "https://openrouter.ai/api/v1/models".to_string(),
            AiProvider::OpenAI => "https://api.openai.com/v1/models".to_string(),
            AiProvider::Anthropic => {
                // Anthropic doesn't have a list models endpoint; return empty
                String::new()
            }
            AiProvider::Ollama => format!("{}/api/tags", ep.ollama.trim_end_matches('/')),
            AiProvider::OpenaiCompatible => {
                format!("{}/models", ep.openai_compat_custom.trim_end_matches('/'))
            }
            AiProvider::Sakana => "https://api.sakana.ai/v1/models".to_string(),
            AiProvider::AiNovelist if api_variant == Some("v1") => {
                ai_novelist::V1_MODELS_URL.to_string()
            }
            AiProvider::AiNovelist => String::new(),
            AiProvider::Cli => String::new(),
        }
    }
}

impl std::fmt::Display for AiProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiProvider::OpenRouter => write!(f, "openrouter"),
            AiProvider::OpenAI => write!(f, "openai"),
            AiProvider::Anthropic => write!(f, "anthropic"),
            AiProvider::Ollama => write!(f, "ollama"),
            AiProvider::OpenaiCompatible => write!(f, "openai-compatible"),
            AiProvider::Sakana => write!(f, "sakana"),
            AiProvider::AiNovelist => write!(f, "ai-novelist"),
            AiProvider::Cli => write!(f, "cli"),
        }
    }
}

fn default_thinking_enabled() -> bool {
    true
}

/// カスタム OpenAI 互換プロバイダ用の設定。
/// ユーザーが任意の OpenAI 互換エンドポイント (llama.cpp / LM Studio 等) を指定する。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenaiCompatibleSettings {
    /// ユーザーが入力する OpenAI 互換エンドポイント
    #[serde(default)]
    pub base_url: String,
    /// 手動指定するモデルのコンテキスト窓
    #[serde(default)]
    pub custom_max_context: Option<u32>,
    /// 手動指定するモデルの最大出力
    #[serde(default)]
    pub custom_max_output: Option<u32>,
    /// AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成タスクで
    /// このプロバイダを使うかどうか。
    #[serde(default)]
    pub enable_structured_tasks: Option<bool>,
}

/// legacy 単一設定の移行で合成する既定エンドポイントの固定 ID。
/// FE (`types.ts`) / Rust / keyring fallback で同じ値を共有する。
pub const LEGACY_OPENAI_COMPAT_ENDPOINT_ID: &str = "default";

/// 1 つの OpenAI 互換エンドポイント設定。`OpenaiCompatibleSettings`（単一）の複数版。
/// `id` は keyring user / override 参照キー、`api_variant` はこのエンドポイント既定の
/// API 経路（未指定ならグローバル / モデル名推論に委ねる）。
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenaiCompatibleEndpoint {
    /// 安定 ID（移行既定は `"default"`、新規は UUID）。
    #[serde(default)]
    pub id: String,
    /// 表示用ラベル。空なら UI で base_url を代用。
    #[serde(default)]
    pub label: String,
    /// OpenAI 互換エンドポイント URL。
    #[serde(default)]
    pub base_url: String,
    /// 手動指定するモデルのコンテキスト窓。
    #[serde(default)]
    pub custom_max_context: Option<u32>,
    /// 手動指定するモデルの最大出力。
    #[serde(default)]
    pub custom_max_output: Option<u32>,
    /// AI Codex 自動抽出 / Synopsis 等の構造化タスクでこのエンドポイントを使うか。
    #[serde(default)]
    pub enable_structured_tasks: Option<bool>,
    /// このエンドポイント既定の API 経路 ("v1" | "responses" | "legacy")。任意。
    #[serde(default)]
    pub api_variant: Option<String>,
}

/// AI のべりすと専用の設定。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiNovelistSettings {
    /// KoboldAI 系独自サンプリングパラメータ (top_a / tailfree 等)。
    /// リクエストボディに素通しされる。
    #[serde(default)]
    pub sampling: Option<serde_json::Value>,
    /// AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成タスクで
    /// このプロバイダを使うかどうか。デフォルト false (構造化出力の精度が低いため)。
    #[serde(default)]
    pub enable_structured_tasks: Option<bool>,
    /// 日本語以外で生成する場合に true (legacy: multilingualmode / v1: multilingual_mode)
    #[serde(default)]
    pub multilingual_mode: Option<bool>,
}

/// CLI プロバイダ用の設定。`provider = Cli` のときのみ意味を持つ。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliSettings {
    /// 使用する CLI 種別 ("claude" / "codex" / "opencode")
    #[serde(default)]
    pub kind: String,
    /// 実行可能ファイルのパス。空なら CLI 名で PATH 解決。
    #[serde(default)]
    pub binary_path: Option<String>,
    /// CLI に渡すモデル名 (--model 経由)。空なら CLI のデフォルトモデル。
    #[serde(default)]
    pub model: Option<String>,
}

/// OpenRouter Fusion (マルチモデル合議) のカスタム構成。
/// model が `"openrouter/fusion"` のときだけ `plugins:[{id:"fusion",...}]` として
/// リクエストへ注入する。`enabled=false` または panel/judge いずれも空なら注入せず、
/// OpenRouter 既定パネル (Quality preset) に委ねる (= 素の openrouter/fusion と同じ)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FusionConfig {
    /// カスタム構成を適用するか。false なら OpenRouter 既定パネルに委ねる。
    #[serde(default)]
    pub enabled: bool,
    /// パネル (analysis_models)。OpenRouter は 1〜8 件を受け付ける。空なら既定。
    #[serde(default)]
    pub analysis_models: Vec<String>,
    /// judge (集約) モデル。None / 空なら既定 (outer)。
    #[serde(default)]
    pub judge_model: Option<String>,
}

/// AI settings persisted in AppData.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: AiProvider,
    pub model: String,
    pub ollama_endpoint: String,
    #[serde(default = "default_thinking_enabled")]
    pub thinking_enabled: bool,
    #[serde(default)]
    pub openai_compatible: OpenaiCompatibleSettings,
    /// 複数 OpenAI 互換エンドポイント。空なら legacy `openai_compatible` から
    /// read 時 normalize で 1 件移行する。
    #[serde(default)]
    pub openai_compatible_endpoints: Vec<OpenaiCompatibleEndpoint>,
    /// 既定（override 無し時）の OpenAI 互換エンドポイント ID。
    #[serde(default)]
    pub active_openai_compatible_endpoint_id: Option<String>,
    #[serde(default)]
    pub ai_novelist: AiNovelistSettings,
    #[serde(default)]
    pub cli: Option<CliSettings>,
    /// OpenRouter で provider routing を 1 つに固定する slug (例: "anthropic", "amazon-bedrock", "google-vertex")。
    /// None なら OpenRouter のデフォルト routing。
    /// 設定すると `provider.order=[slug]` + `allow_fallbacks=true` を body に注入し、
    /// Anthropic prompt cache が同一 provider に当たりやすくする。
    #[serde(default)]
    pub openrouter_provider_pin: Option<String>,
    /// 選択中モデルの API 経路 ("legacy" | "v1")。バックエンド専用呼び出しの fallback 用。
    #[serde(default, rename = "modelApiVariant")]
    pub model_api_variant: Option<String>,
    /// reasoning effort 上書き ("low" | "medium" | "high")。
    /// Rust は chat では読まないが、設定の save 往復で serde に捨てられないよう構造体に保持する。
    #[serde(default)]
    pub reasoning_effort_override: Option<String>,
    /// Agent ツール呼び出しプロトコル（auto | native | hermes）。
    #[serde(default)]
    pub tool_protocol_mode: ToolProtocolMode,
    /// OpenRouter Fusion のカスタム構成 (model="openrouter/fusion" 時のみ適用)。
    #[serde(default)]
    pub fusion: FusionConfig,
}

impl AiSettings {
    pub fn endpoints(&self) -> ProviderEndpoints<'_> {
        ProviderEndpoints {
            ollama: &self.ollama_endpoint,
            // 解決済みエンドポイント（active / override id）の base_url。
            // normalize 前 / 空配列でも legacy base_url にフォールバックする。
            openai_compat_custom: self
                .active_openai_compatible_endpoint()
                .map(|e| e.base_url.as_str())
                .unwrap_or(self.openai_compatible.base_url.as_str()),
        }
    }

    /// legacy 単一設定を `openai_compatible_endpoints` へ移行する（read 時に一度呼ぶ）。
    /// endpoints が空かつ legacy base_url が非空なら `"default"` エンドポイントを合成し、
    /// active id が未設定 / 不正なら先頭にフォールバックする。冪等。
    pub fn normalize_openai_compatible(&mut self) {
        if self.openai_compatible_endpoints.is_empty()
            && !self.openai_compatible.base_url.trim().is_empty()
        {
            self.openai_compatible_endpoints
                .push(OpenaiCompatibleEndpoint {
                    id: LEGACY_OPENAI_COMPAT_ENDPOINT_ID.to_string(),
                    label: String::new(),
                    base_url: self.openai_compatible.base_url.clone(),
                    custom_max_context: self.openai_compatible.custom_max_context,
                    custom_max_output: self.openai_compatible.custom_max_output,
                    enable_structured_tasks: self.openai_compatible.enable_structured_tasks,
                    api_variant: None,
                });
        }
        let active_valid = self
            .active_openai_compatible_endpoint_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(|id| self.openai_compatible_endpoints.iter().any(|e| e.id == id))
            .unwrap_or(false);
        if !active_valid {
            self.active_openai_compatible_endpoint_id = self
                .openai_compatible_endpoints
                .first()
                .map(|e| e.id.clone());
        }
    }

    /// 指定 id の OpenAI 互換エンドポイントが存在するか。
    /// 送信コマンドは per-call override をこれで検証し、未知 id で別サーバへ
    /// 無言フォールバックするのを防ぐ。
    pub fn has_openai_compatible_endpoint(&self, id: &str) -> bool {
        self.openai_compatible_endpoints.iter().any(|e| e.id == id)
    }

    /// `active_openai_compatible_endpoint_id`（送信コマンドが override をここに載せる）→
    /// 先頭、の順で解決した OpenAI 互換エンドポイント。配列が空なら None。
    pub fn active_openai_compatible_endpoint(&self) -> Option<&OpenaiCompatibleEndpoint> {
        if self.openai_compatible_endpoints.is_empty() {
            return None;
        }
        if let Some(id) = self
            .active_openai_compatible_endpoint_id
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            if let Some(found) = self.openai_compatible_endpoints.iter().find(|e| e.id == id) {
                return Some(found);
            }
        }
        self.openai_compatible_endpoints.first()
    }
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: AiProvider::OpenRouter,
            model: String::new(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            thinking_enabled: true,
            openai_compatible: OpenaiCompatibleSettings::default(),
            openai_compatible_endpoints: Vec::new(),
            active_openai_compatible_endpoint_id: None,
            ai_novelist: AiNovelistSettings::default(),
            cli: None,
            openrouter_provider_pin: None,
            model_api_variant: None,
            reasoning_effort_override: None,
            tool_protocol_mode: ToolProtocolMode::default(),
            fusion: FusionConfig::default(),
        }
    }
}

/// Model entry returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    pub name: String,
    #[serde(
        default,
        rename = "apiVariant",
        skip_serializing_if = "Option::is_none"
    )]
    pub api_variant: Option<String>,
    /// OpenRouter: context window in tokens (context_length)
    #[serde(
        default,
        rename = "contextLength",
        skip_serializing_if = "Option::is_none"
    )]
    pub context_length: Option<u64>,
    /// OpenRouter: max completion tokens (top_provider.max_completion_tokens)
    #[serde(
        default,
        rename = "maxCompletionTokens",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_completion_tokens: Option<u64>,
    /// OpenRouter: supported parameter names (supported_parameters[])
    #[serde(
        default,
        rename = "supportedParameters",
        skip_serializing_if = "Option::is_none"
    )]
    pub supported_parameters: Option<Vec<String>>,
    /// OpenRouter: pricing.prompt (USD per token as string)
    #[serde(
        default,
        rename = "pricingPrompt",
        skip_serializing_if = "Option::is_none"
    )]
    pub pricing_prompt: Option<String>,
    /// OpenRouter: pricing.completion (USD per token as string)
    #[serde(
        default,
        rename = "pricingCompletion",
        skip_serializing_if = "Option::is_none"
    )]
    pub pricing_completion: Option<String>,
}

/// Parse a single OpenRouter model entry from the /api/v1/models response.
fn parse_openrouter_model(m: &serde_json::Value) -> Option<AiModel> {
    let id = m["id"].as_str()?;
    let name = m["name"].as_str().unwrap_or(id);
    let context_length = m["context_length"].as_u64();
    let max_completion_tokens = m["top_provider"]["max_completion_tokens"].as_u64();
    let supported_parameters = m["supported_parameters"].as_array().map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>()
    });
    let pricing_prompt = m["pricing"]["prompt"].as_str().map(|s| s.to_string());
    let pricing_completion = m["pricing"]["completion"].as_str().map(|s| s.to_string());
    Some(AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: None,
        context_length,
        max_completion_tokens,
        supported_parameters,
        pricing_prompt,
        pricing_completion,
    })
}

fn legacy_ainoverist_model(id: &str, name: &str) -> AiModel {
    AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: Some("legacy".to_string()),
        context_length: None,
        max_completion_tokens: None,
        supported_parameters: None,
        pricing_prompt: None,
        pricing_completion: None,
    }
}

fn v1_ainoverist_model(id: &str, name: &str) -> AiModel {
    AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: Some("v1".to_string()),
        context_length: None,
        max_completion_tokens: None,
        supported_parameters: None,
        pricing_prompt: None,
        pricing_completion: None,
    }
}

/// レガシー + v1 モデル一覧をマージする。同一 id は v1 を優先。
pub fn merge_ainoverist_models(legacy: Vec<AiModel>, v1: Vec<AiModel>) -> Vec<AiModel> {
    let mut by_id: std::collections::HashMap<String, AiModel> = std::collections::HashMap::new();
    for m in legacy {
        by_id.insert(m.id.clone(), m);
    }
    for m in v1 {
        by_id.insert(m.id.clone(), m);
    }
    let mut merged: Vec<AiModel> = by_id.into_values().collect();
    merged.sort_by(|a, b| a.id.cmp(&b.id));
    merged
}

async fn fetch_ainoverist_v1_models(api_key: &str) -> anyhow::Result<Vec<AiModel>> {
    if api_key.is_empty() {
        return Ok(ai_novelist::known_v1_models_static()
            .into_iter()
            .map(|(id, name)| v1_ainoverist_model(id, name))
            .collect());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get(ai_novelist::V1_MODELS_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .send()
        .await?
        .error_for_status()?;
    let body: serde_json::Value = resp.json().await?;
    let models = body["data"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let name = m["name"]
                .as_str()
                .or_else(|| m["id"].as_str())
                .unwrap_or(id);
            Some(v1_ainoverist_model(id, name))
        })
        .collect();
    Ok(models)
}

fn static_legacy_ainoverist_models() -> Vec<AiModel> {
    ai_novelist::legacy_models()
        .into_iter()
        .map(|(id, name)| legacy_ainoverist_model(id, name))
        .collect()
}

fn static_v1_ainoverist_models() -> Vec<AiModel> {
    ai_novelist::known_v1_models_static()
        .into_iter()
        .map(|(id, name)| v1_ainoverist_model(id, name))
        .collect()
}

/// 明示 api_variant → settings.model_api_variant → モデル名推論 の順で解決。
pub fn resolve_api_variant(
    explicit: Option<&str>,
    settings: &AiSettings,
    model: &str,
) -> Option<String> {
    // openrouter/fusion (マルチモデル合議) は /chat/completions 専用機能。fusion plugin
    // (plugins[{id:"fusion", analysis_models}]) は ai_responses (/responses 経路) では
    // 注入されないため、Responses トグルが ON でも必ず chat/completions に通す
    // (= responses variant を握り潰す)。これをしないと fusion が無言で既定パネルに落ちる。
    if model == "openrouter/fusion" {
        return None;
    }
    if let Some(v) = explicit.filter(|s| !s.is_empty()) {
        return Some(v.to_string());
    }
    // OpenAI 互換: 経路はエンドポイント単位の api_variant が正本。グローバル
    // model_api_variant（Responses トグル）は openai-compatible では UI に出さない
    // 設計（AiCategory: トグル非表示）なので、ここでも持ち込まない。これを怠ると
    // 他プロバイダで ON にした "responses" が残留して /responses 非対応の互換サーバ
    // (PlaMo / LM Studio 等) に漏れ 404 になる。endpoint 未指定(auto)は
    // None=/chat/completions（互換サーバ共通の基準経路）に解決する。
    if matches!(settings.provider, AiProvider::OpenaiCompatible) {
        return settings.active_openai_compatible_endpoint().and_then(|ep| {
            ep.api_variant
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        });
    }
    if let Some(ref v) = settings.model_api_variant {
        if !v.is_empty() {
            return Some(v.clone());
        }
    }
    if matches!(settings.provider, AiProvider::AiNovelist) {
        if ai_novelist::is_v1_variant(None, model) {
            return Some("v1".to_string());
        }
        return Some("legacy".to_string());
    }
    None
}

fn is_ainoverist_v1(params: &ChatParams<'_>) -> bool {
    matches!(params.provider, AiProvider::AiNovelist)
        && ai_novelist::is_v1_variant(params.api_variant.as_deref(), params.model)
}

/// OpenRouter 経由でも OpenAI o系 / gpt-5系などの reasoning モデルは hidden
/// reasoning トークンが `max_tokens` に課金されるため、4096 では content が空
/// (finish_reason:length)になりうる。該当モデルを検出して予算に余裕を持たせる
/// (OpenAI 直叩きの 32k 余裕と同根)。`gpt-5-chat` は非 reasoning なので除外する。
pub(crate) fn is_openrouter_reasoning_model(model: &str) -> bool {
    // provider プレフィックス(`openai/` `deepseek/` 等)を剥がして素のモデル名で判定。
    let m = model.rsplit('/').next().unwrap_or(model);
    if m.starts_with("gpt-5-chat") {
        return false;
    }
    m.starts_with("gpt-5")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.starts_with("deepseek-r1")
}

fn openai_max_tokens(params: &ChatParams<'_>) -> u32 {
    if is_ainoverist_v1(params) {
        ai_novelist::length_for(params.model)
    } else if matches!(params.provider, AiProvider::OpenAI | AiProvider::Sakana)
        || is_openrouter_reasoning_model(params.model)
    {
        // reasoning モデルは hidden reasoning も max_tokens / max_completion_tokens に
        // 課金されるため、4096 では content が空 (finish_reason:length) になりうる。
        // OpenAI 直叩き全般 + Sakana(fugu は reasoning) + OpenRouter 経由の reasoning
        // モデルに余裕を持たせる。
        32_000
    } else {
        4096
    }
}

/// OpenAI-compatible body にトークン上限を挿入する。
/// OpenAI 直叩きは reasoning モデルが `max_tokens` を 400 拒否するため `max_completion_tokens` を使う。
/// Sakana も OpenAI 互換の直 API で fugu は reasoning なので同様に `max_completion_tokens`。
/// OpenRouter は OpenAI モデルでも OpenRouter wire format なので `max_tokens` のままでよい。
fn insert_chat_completion_token_limit(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    value: u32,
) {
    let key = if matches!(provider, AiProvider::OpenAI | AiProvider::Sakana) {
        "max_completion_tokens"
    } else {
        "max_tokens"
    };
    body[key] = serde_json::json!(value);
}

/// gpt-5.1 以降は `reasoning_effort:"none"` 対応。それ以前 (o3 / o4-mini / gpt-5 / gpt-5-mini) は非対応。
/// gpt-5-pro (high 固定) と gpt-5-chat (非 reasoning) は対象外。ドット/ダッシュ両表記を許容。
pub(crate) fn openai_model_supports_reasoning_none(model: &str) -> bool {
    let m = model.strip_prefix("openai/").unwrap_or(model);
    if m.starts_with("gpt-5-pro") || m.starts_with("gpt-5-chat") {
        return false;
    }
    for sep in ['.', '-'] {
        let prefix = format!("gpt-5{sep}");
        if let Some(rest) = m.strip_prefix(&prefix) {
            if let Some(first) = rest.chars().next() {
                if first.is_ascii_digit() && first != '0' {
                    return true;
                }
            }
        }
    }
    false
}

/// gpt-5-pro は effort=high 固定。low/medium を送ると 400 になるため high に丸める。
pub(crate) fn openai_model_requires_high_effort(model: &str) -> bool {
    let m = model.strip_prefix("openai/").unwrap_or(model);
    m.starts_with("gpt-5-pro")
}

/// Read AI settings from the given file path.
pub fn read_ai_settings(path: &Path) -> AiSettings {
    let mut settings = match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AiSettings::default(),
    };
    // legacy 単一 OpenAI 互換設定を複数エンドポイント配列へ移行（冪等）。
    settings.normalize_openai_compatible();
    settings
}

/// Write AI settings to the given file path.
pub fn write_ai_settings(path: &Path, settings: &AiSettings) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(path, json)?;
    Ok(())
}

const KEYRING_USER: &str = "grimodex-user";

/// keyring の account (user)。OpenAI 互換は endpoint_id を user に載せて
/// エンドポイントごとに別キーを保存する（service 名は provider 単位で不変）。
/// それ以外のプロバイダは従来どおり単一の `KEYRING_USER`。
fn keyring_user(provider: &AiProvider, endpoint_id: Option<&str>) -> String {
    match (provider, endpoint_id) {
        (AiProvider::OpenaiCompatible, Some(id)) if !id.is_empty() => id.to_string(),
        _ => KEYRING_USER.to_string(),
    }
}

/// 指定 (provider, endpoint_id) のキーを解決する際に試す keyring user を優先順に返す。
/// OpenAI 互換の移行既定エンドポイント (`"default"`) は、まず自分の user を引き、無ければ
/// 旧 user (`grimodex-user`) にフォールバックする（移行ユーザーの既存キーを無入力で継続）。
///
/// `get_api_key` はこの順で最初に見つかったキーを返し、`delete_api_key` はこのリスト
/// 全員を削除する。両者を同じ候補列に通すことで、「`"default"` で削除しても legacy が
/// 残り `has_api_key` が true を返し続ける（＝削除ボタンが無反応に見える）」非対称バグを
/// 構造的に封じる。新規追加した任意 id のエンドポイントは fallback を持たない。
fn keyring_user_candidates(provider: &AiProvider, endpoint_id: Option<&str>) -> Vec<String> {
    let primary = keyring_user(provider, endpoint_id);
    if matches!(provider, AiProvider::OpenaiCompatible)
        && endpoint_id == Some(LEGACY_OPENAI_COMPAT_ENDPOINT_ID)
    {
        // primary == "default"。legacy user は必ず別名なので重複しない。
        vec![primary, KEYRING_USER.to_string()]
    } else {
        vec![primary]
    }
}

/// Save an API key to the OS keyring.
/// `endpoint_id` は OpenAI 互換プロバイダでのみ意味を持つ（per-endpoint キー）。
pub fn save_api_key(
    provider: &AiProvider,
    endpoint_id: Option<&str>,
    key: &str,
) -> anyhow::Result<()> {
    let user = keyring_user(provider, endpoint_id);
    let entry = keyring::Entry::new(provider.keyring_service(), &user)?;
    entry.set_password(key)?;
    Ok(())
}

/// Get an API key from the OS keyring. Returns None if not found.
/// 移行既定エンドポイント (`"default"`) は NoEntry 時のみ旧 user (`grimodex-user`) を
/// フォールバックで試し、移行ユーザーの既存キーを無入力で継続させる。新規追加した
/// エンドポイントの欠落キーをマスクしないよう、fallback は `"default"` のみ対象。
pub fn get_api_key(
    provider: &AiProvider,
    endpoint_id: Option<&str>,
) -> anyhow::Result<Option<String>> {
    for user in keyring_user_candidates(provider, endpoint_id) {
        let entry = keyring::Entry::new(provider.keyring_service(), &user)?;
        match entry.get_password() {
            Ok(key) => return Ok(Some(key)),
            Err(keyring::Error::NoEntry) => continue, // 次の候補（legacy fallback）を試す
            Err(e) => return Err(anyhow::anyhow!("Keyring error: {e}")),
        }
    }
    Ok(None)
}

/// Delete an API key from the OS keyring.
/// 候補 user を全員削除する。`get_api_key` の legacy フォールバックと対称にすることで、
/// 移行既定エンドポイント (`"default"`) で削除しても旧 user のキーが残り続ける（削除が
/// 無反応に見え、しかも実送信では旧キーが使われ続ける）バグを防ぐ。
pub fn delete_api_key(provider: &AiProvider, endpoint_id: Option<&str>) -> anyhow::Result<()> {
    for user in keyring_user_candidates(provider, endpoint_id) {
        let entry = keyring::Entry::new(provider.keyring_service(), &user)?;
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {} // Already gone
            Err(e) => return Err(anyhow::anyhow!("Keyring error: {e}")),
        }
    }
    Ok(())
}

/// Fetch available models from the provider.
pub async fn fetch_models(
    provider: &AiProvider,
    api_key: &str,
    endpoints: ProviderEndpoints<'_>,
) -> anyhow::Result<Vec<AiModel>> {
    // 静的リストを持つプロバイダは HTTP を叩かずに返す
    match provider {
        AiProvider::Anthropic => {
            return Ok(vec![
                AiModel {
                    id: "claude-fable-5".to_string(),
                    name: "Claude Fable 5".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
                AiModel {
                    id: "claude-opus-4-8".to_string(),
                    name: "Claude Opus 4.8".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
                AiModel {
                    id: "claude-opus-4-7".to_string(),
                    name: "Claude Opus 4.7".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
                AiModel {
                    id: "claude-opus-4-6".to_string(),
                    name: "Claude Opus 4.6".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
                AiModel {
                    id: "claude-sonnet-4-6".to_string(),
                    name: "Claude Sonnet 4.6".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
                AiModel {
                    id: "claude-haiku-4-5-20251001".to_string(),
                    name: "Claude Haiku 4.5".to_string(),
                    api_variant: None,
                    context_length: None,
                    max_completion_tokens: None,
                    supported_parameters: None,
                    pricing_prompt: None,
                    pricing_completion: None,
                },
            ]);
        }
        AiProvider::AiNovelist => {
            let legacy = static_legacy_ainoverist_models();
            let v1 = fetch_ainoverist_v1_models(api_key)
                .await
                .unwrap_or_else(|_| static_v1_ainoverist_models());
            return Ok(merge_ainoverist_models(legacy, v1));
        }
        _ => {}
    }

    let url = provider.models_url(endpoints, None);
    if url.is_empty() {
        return Ok(vec![]);
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url);

    match provider {
        AiProvider::Ollama => {} // No auth needed
        AiProvider::OpenRouter => {
            req = req
                .header("Authorization", format!("Bearer {api_key}"))
                .header("HTTP-Referer", "https://github.com/kazormia296/Grimodex")
                .header("X-Title", "Grimodex");
        }
        AiProvider::OpenaiCompatible => {
            // ローカル LLM 等で API キー不要のサーバには Authorization ヘッダ自体を付けない
            if !api_key.is_empty() {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
        }
        _ => {
            req = req.header("Authorization", format!("Bearer {api_key}"));
        }
    }

    let resp = req.send().await?.error_for_status()?;
    let body: serde_json::Value = resp.json().await?;

    let models = match provider {
        AiProvider::Ollama => {
            // Ollama returns { "models": [{ "name": "...", ... }] }
            body["models"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|m| {
                    let name = m["name"].as_str()?;
                    Some(AiModel {
                        id: name.to_string(),
                        name: name.to_string(),
                        api_variant: None,
                        context_length: None,
                        max_completion_tokens: None,
                        supported_parameters: None,
                        pricing_prompt: None,
                        pricing_completion: None,
                    })
                })
                .collect()
        }
        AiProvider::OpenRouter => {
            // OpenRouter returns { "data": [{ "id", "name", "context_length",
            //   "top_provider": { "max_completion_tokens" }, "supported_parameters",
            //   "pricing": { "prompt", "completion" } }] }
            body["data"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(parse_openrouter_model)
                .collect()
        }
        _ => {
            // OpenAI / OpenaiCompatible: { "data": [{ "id": "...", "name": "..." }] }
            body["data"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?;
                    let name = m["name"]
                        .as_str()
                        .or_else(|| m["id"].as_str())
                        .unwrap_or(id);
                    Some(AiModel {
                        id: id.to_string(),
                        name: name.to_string(),
                        api_variant: None,
                        context_length: None,
                        max_completion_tokens: None,
                        supported_parameters: None,
                        pricing_prompt: None,
                        pricing_completion: None,
                    })
                })
                .collect()
        }
    };

    Ok(models)
}

/// Test connection by sending a minimal chat completion request.
pub async fn test_connection(
    provider: &AiProvider,
    model: &str,
    api_key: &str,
    endpoints: ProviderEndpoints<'_>,
    api_variant: Option<&str>,
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();

    // AI のべりすと legacy: 独自エンドポイント (POST <base>) + text / length フィールド
    if matches!(provider, AiProvider::AiNovelist) && !ai_novelist::is_v1_variant(api_variant, model)
    {
        let url = provider.base_url(endpoints);
        if url.is_empty() {
            return Err(anyhow::anyhow!(
                "AI のべりすと: base URL が設定されていません"
            ));
        }
        let body = serde_json::json!({
            "text": "Reply with exactly: Connection OK",
            "model": model,
            // 接続確認用なので最小値で十分（length 必須）
            "length": 32,
        });
        let resp = client
            .post(&url)
            .header("content-type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        let result: serde_json::Value = resp.json().await?;
        let response = parse_ainoverist_response(&result)?;
        let text = response
            .blocks
            .into_iter()
            .find_map(|b| match b {
                ResponseBlock::Text { content } => Some(content),
                _ => None,
            })
            .unwrap_or_default();
        return Ok(if text.is_empty() {
            "Connection successful (empty response)".to_string()
        } else {
            text
        });
    }

    match provider {
        AiProvider::Anthropic => {
            // Anthropic uses a different API format
            let url = format!("{}/messages", provider.base_url(endpoints));
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 32,
                "messages": [
                    { "role": "user", "content": "Reply with exactly: Connection OK" }
                ]
            });

            let resp = client
                .post(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;

            let result: serde_json::Value = resp.json().await?;
            let text = result["content"][0]["text"]
                .as_str()
                .unwrap_or("Connection successful");
            Ok(text.to_string())
        }
        AiProvider::Ollama => {
            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(endpoints, api_variant)
            );
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 32,
                "messages": [
                    { "role": "user", "content": "Reply with exactly: Connection OK" }
                ]
            });

            let resp = client
                .post(&url)
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;

            let result: serde_json::Value = resp.json().await?;
            let text = result["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("Connection successful");
            Ok(text.to_string())
        }
        _ => {
            // OpenAI-compatible format (OpenRouter, OpenAI, OpenaiCompatible, AiNovelist v1)
            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(endpoints, api_variant)
            );
            let mut body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "user", "content": "Reply with exactly: Connection OK" }
                ]
            });
            // OpenAI 直叩き / Sakana(fugu) は reasoning モデルだと 32 トークンでは hidden
            // reasoning だけで枯れる + `max_tokens` を 400 拒否するため、key/予算を分岐する。
            let probe_limit = if matches!(provider, AiProvider::OpenAI | AiProvider::Sakana) {
                1024
            } else {
                32
            };
            insert_chat_completion_token_limit(&mut body, provider, probe_limit);

            let mut req = client.post(&url).header("content-type", "application/json");

            // OpenaiCompatible で API キー未設定 (ローカル LLM 等) の場合は
            // Authorization ヘッダ自体を付けない
            let needs_auth =
                !matches!(provider, AiProvider::OpenaiCompatible) || !api_key.is_empty();
            if needs_auth {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }

            if matches!(provider, AiProvider::OpenRouter) {
                req = req
                    .header("HTTP-Referer", "https://github.com/kazormia296/Grimodex")
                    .header("X-Title", "Grimodex");
            }

            let resp = req.json(&body).send().await?.error_for_status()?;

            let result: serde_json::Value = resp.json().await?;
            let text = result["choices"][0]["message"]["content"]
                .as_str()
                .unwrap_or("Connection successful");
            Ok(text.to_string())
        }
    }
}

/// AI のべりすとの API 呼び出しモード。
/// - `Chat`: チャットパネル・バックグラウンド処理 → `messages` 配列形式（Chat API）
/// - `Completion`: インラインAI（続きを書く） → `text` 平坦化形式（Completion API）
///
/// 他プロバイダには影響しない。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiNovelistMode {
    Chat,
    Completion,
}

/// Web 検索 (RAG) 設定。FE の 🌐 トグルから渡される。
/// Phase 1 では OpenRouter (web plugin / server tool) と Anthropic (native
/// web_search) のみ対応。検索はプロバイダのサーバ側で実行され、結果と引用は
/// 同一レスポンスで返る (自前の取得ループは無い)。
#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    /// 検索を有効化するか。
    pub enabled: bool,
    /// Agent モード併用時は true。OpenRouter では server tool
    /// (`openrouter:web_search`) を、false では一発検索の web plugin を使う。
    /// Anthropic は常に native web_search ツール (max_uses でキャップ)。
    #[serde(default)]
    pub agentic: bool,
    /// OpenRouter web plugin の最大取得件数 (0 ならデフォルト 5)。
    #[serde(default)]
    pub max_results: u32,
    /// Anthropic native web_search の最大検索回数 (0 ならデフォルト 3)。
    #[serde(default)]
    pub max_uses: u32,
    /// Phase 2: ドメイン allowlist (空なら無効)。Anthropic native /
    /// OpenRouter(exa) のドメイン制御に渡る。blocked と排他で allowed を優先。
    #[serde(default)]
    pub allowed_domains: Vec<String>,
    /// Phase 2: ドメイン blocklist (空なら無効)。
    #[serde(default)]
    pub blocked_domains: Vec<String>,
    /// Phase 2: OpenRouter(exa) の 1 ページ content token 上限 (0 = 既定)。
    /// Anthropic には対応フィールドが無いので送らない。
    #[serde(default)]
    pub max_content_tokens: u32,
}

impl WebSearchConfig {
    /// 取得件数 (0 → デフォルト 5)。
    fn results_cap(&self) -> u32 {
        if self.max_results == 0 {
            5
        } else {
            self.max_results
        }
    }

    /// 検索回数 (0 → デフォルト 3)。
    fn uses_cap(&self) -> u32 {
        if self.max_uses == 0 {
            3
        } else {
            self.max_uses
        }
    }

    /// 有効なドメインフィルタを返す (allowed 優先の排他)。
    /// `Some((true, domains))` = allowlist, `Some((false, domains))` = blocklist,
    /// `None` = フィルタなし。Anthropic は allowed/blocked 同時指定不可のため、
    /// FE 側でも片方に倒しているが、ここでも防御的に allowed を優先する。
    fn domain_filter(&self) -> Option<(bool, &[String])> {
        if !self.allowed_domains.is_empty() {
            Some((true, &self.allowed_domains))
        } else if !self.blocked_domains.is_empty() {
            Some((false, &self.blocked_domains))
        } else {
            None
        }
    }

    /// OpenRouter で exa エンジンを強制すべきか。
    /// ドメイン制御 or content cap が指定されたターンのみ true にし、それ以外は
    /// auto (ネイティブ優先・パススルー課金) のままにする (コスト退行防止, §5-4)。
    fn needs_exa_engine(&self) -> bool {
        self.domain_filter().is_some() || self.max_content_tokens > 0
    }
}

/// Anthropic native web_search サーバツール定義を組み立てる (Phase 1 + Phase 2)。
/// `max_uses` でキャップし、ドメイン制御があれば `allowed_domains` /
/// `blocked_domains` を付与する (排他)。Anthropic には content token 上限の
/// フィールドが無いため `max_content_tokens` は載せない (dynamic filtering 任せ)。
fn build_anthropic_web_search_tool(ws: &WebSearchConfig) -> serde_json::Value {
    let mut tool = serde_json::json!({
        "type": ANTHROPIC_WEB_SEARCH_TYPE,
        "name": "web_search",
        "max_uses": ws.uses_cap()
    });
    if let Some((is_allow, domains)) = ws.domain_filter() {
        let key = if is_allow {
            "allowed_domains"
        } else {
            "blocked_domains"
        };
        tool[key] = serde_json::json!(domains);
    }
    tool
}

/// OpenRouter web plugin / server tool に Phase 2 の制御 (engine=exa・ドメイン
/// フィルタ・content token 上限) を付与する。`needs_exa_engine()` が true の
/// ターンのみ呼ぶこと (Phase 1 = controls off のターンは未変更で auto のまま)。
///
/// ⚠️ live API 未検証 (egress firewall で openrouter.ai 到達不可)。フィールド名は
/// 2026-06 時点のドキュメント二次情報に基づく最有力推定。手動 E2E で要確認:
///   - `engine: "exa"` … auto→exa 強制でドメイン/サイズ制御を全モデルで一貫させる (§5-4)。
///     plugin 側では確立した値だが、server tool オブジェクト上で有効かは未確認。
///   - `allowed_domains` / `blocked_domains` … plugin 経路では `include_domains` /
///     `exclude_domains` の別名の可能性。exa エンジン経路では allowed/blocked が有力。
///   - `max_content_tokens` … server tool 経路では `search_context_size` の別名の可能性。
///
/// 注意: この関数は plugin (`{id:"web"}`) と server tool
/// (`{type:"openrouter:web_search"}`) の構造の異なる 2 面に同一キーを載せる。
/// 2 面でスキーマが分岐する場合、面ごとに分岐させる必要がある。OpenRouter が
/// 未知フィールドを無視するなら「exa 課金は発生するがドメイン制御は黙殺」
/// (誤った安心感)、strict 検証なら HTTP 400 で当該ターンが失敗する
/// (send_with_429_retry は 429 のみリトライ、400 は素通り)。どちらに転ぶかは
/// E2E でのみ確定する。修正が要る場合の変更点はこの関数 1 箇所に閉じている。
fn apply_openrouter_web_controls(target: &mut serde_json::Value, ws: &WebSearchConfig) {
    target["engine"] = serde_json::json!("exa");
    if let Some((is_allow, domains)) = ws.domain_filter() {
        let key = if is_allow {
            "allowed_domains"
        } else {
            "blocked_domains"
        };
        target[key] = serde_json::json!(domains);
    }
    if ws.max_content_tokens > 0 {
        target["max_content_tokens"] = serde_json::json!(ws.max_content_tokens);
    }
}

/// Parameters shared across all AI chat functions.
pub struct ChatParams<'a> {
    pub provider: &'a AiProvider,
    pub model: &'a str,
    pub api_key: &'a str,
    pub endpoints: ProviderEndpoints<'a>,
    pub thinking: Option<ThinkingConfig>,
    pub effort: Option<String>,
    pub reasoning_enabled: Option<bool>,
    pub reasoning_effort: Option<String>,
    /// AI のべりすと等が要求する追加リクエストボディフィールド。
    /// `top_a` / `tailfree` 等の独自サンプリングパラメータを
    /// オブジェクトで渡すと、`send_chat*` がリクエストボディにマージする。
    pub extra_body: Option<serde_json::Value>,
    /// 429 (Too Many Requests) を受けたときに指数バックオフでリトライするか。
    pub retry_429: bool,
    /// AI のべりすと専用: Chat API / Completion API の選択。
    pub ai_novelist_mode: AiNovelistMode,
    /// OpenRouter で provider routing を固定する slug (例: "anthropic")。
    /// None / 空文字なら適用しない。Anthropic prompt cache を効かせるための設定。
    pub openrouter_provider_pin: Option<&'a str>,
    /// Chat L1–L4 boundary segments for Anthropic `cache_control` markers.
    pub system_cache_segments: Option<Vec<String>>,
    /// cache_segments の後ろに cache_control 無しで送る揮発層
    /// (非 stable L4 + L5 会話要約 + L6 コマンド指示)。cache_segments を使う
    /// プロバイダは system message 本文 (fallback) を破棄するため、ここに
    /// 乗せないと揮発層がモデルへ届かない。cache_segments 不使用経路では
    /// fallback (= prompt 全文) が揮発層を含むので付与不要。
    pub system_volatile_tail: Option<String>,
    /// AI のべりすと: "legacy" | "v1"。FE から渡される API 経路。
    pub api_variant: Option<String>,
    /// Web 検索 (RAG) 設定。None または `enabled=false` なら検索を注入しない。
    pub web_search: Option<WebSearchConfig>,
    /// OpenRouter Fusion 構成。model=="openrouter/fusion" のとき `plugins` へ注入する。
    /// None または enabled=false / 空構成なら注入しない (OpenRouter 既定パネル)。
    pub fusion: Option<&'a FusionConfig>,
    /// 解決済みツールプロトコル（native | hermes）。
    /// Hermes のとき本文 `<tool_call>` を受信パースし、stop_reason を上書きする。
    pub resolved_tool_protocol: ResolvedToolProtocol,
}

fn supports_prompt_cache(provider: &AiProvider, model: &str) -> bool {
    matches!(provider, AiProvider::Anthropic)
        || (matches!(provider, AiProvider::OpenRouter) && model.contains("claude"))
}

/// Build Anthropic/OpenRouter-Claude system payload with optional cache markers.
/// `volatile_tail` は cache_control 無しの末尾ブロックとして付く (L5 会話要約等)。
/// fallback (= prompt 全文) には揮発層が既に含まれるため、fallback 経路では付けない。
fn build_system_payload(
    provider: &AiProvider,
    model: &str,
    fallback: &str,
    cache_segments: Option<&[String]>,
    volatile_tail: Option<&str>,
) -> serde_json::Value {
    let tail = volatile_tail.filter(|t| !t.is_empty());
    if let Some(segments) = cache_segments {
        if supports_prompt_cache(provider, model) {
            let mut blocks: Vec<serde_json::Value> = segments
                .iter()
                .filter(|s| !s.is_empty())
                .map(|text| {
                    serde_json::json!({
                        "type": "text",
                        "text": text,
                        "cache_control": { "type": "ephemeral" }
                    })
                })
                .collect();
            if !blocks.is_empty() {
                // AUDIT POINT: Chat cache_control at L1/L2/L3/L4 boundaries (4 segments max).
                if let Some(tail) = tail {
                    blocks.push(serde_json::json!({ "type": "text", "text": tail }));
                }
                return serde_json::Value::Array(blocks);
            }
        }
        let mut joined = segments.join("\n");
        if let Some(tail) = tail {
            if !joined.is_empty() {
                joined.push('\n');
            }
            joined.push_str(tail);
        }
        if !joined.is_empty() {
            return serde_json::Value::String(joined);
        }
    }
    serde_json::Value::String(fallback.to_string())
}

/// cache_segments を OpenAI 互換の content block 配列 (各 block に cache_control) へ変換する。
/// 空セグメントは除外。全部空なら None (plain string にフォールバック)。
/// 上限 4 ブレークポイントは呼び出し側 (FE の L1–L4) が満たす前提。
fn openai_system_cache_blocks(segments: &[String]) -> Option<Vec<serde_json::Value>> {
    let blocks: Vec<serde_json::Value> = segments
        .iter()
        .filter(|s| !s.is_empty())
        .map(|text| {
            serde_json::json!({
                "type": "text",
                "text": text,
                "cache_control": { "type": "ephemeral" }
            })
        })
        .collect();
    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

/// OpenAI 互換 (/chat/completions) 用に messages を `[{role, content}]` へ組み立てる。
/// OpenRouter + Claude かつ cache_segments があるとき、最初の system メッセージの
/// content を cache_control 付き text block 配列にして prompt cache を効かせる
/// (OpenRouter は per-block cache_control を Anthropic / Bedrock / Vertex へ中継する)。
/// それ以外は従来どおり content を plain string で送る。
/// top-level cache_control は併用しない (explicit と automatic の衝突で 400 になるため)。
fn build_openai_chat_messages(
    messages: &[(&str, &str)],
    provider: &AiProvider,
    model: &str,
    cache_segments: Option<&[String]>,
    volatile_tail: Option<&str>,
) -> Vec<serde_json::Value> {
    let cache_blocks = if supports_prompt_cache(provider, model) {
        cache_segments
            .and_then(openai_system_cache_blocks)
            .map(|mut blocks| {
                // 揮発層 (非 stable L4 + L5/L6) は cache_control 無しで後置。
                // blocks 置換時は元の system 本文 (= prompt 全文) が捨てられる
                // ため、ここに乗せないと揮発層が届かない。
                if let Some(tail) = volatile_tail.filter(|t| !t.is_empty()) {
                    blocks.push(serde_json::json!({ "type": "text", "text": tail }));
                }
                blocks
            })
    } else {
        None
    };
    let mut applied = false;
    messages
        .iter()
        .map(|(role, content)| {
            if *role == "system" && !applied {
                if let Some(blocks) = &cache_blocks {
                    applied = true;
                    return serde_json::json!({ "role": "system", "content": blocks });
                }
            }
            serde_json::json!({ "role": role, "content": content })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// AI のべりすと専用パス
//
// OpenAI 互換ではない独自フォーマット:
// - エンドポイント: `<base>` 自体に POST (パス追加なし)
// - ボディ: { text: <flatten>, ...sampling }
// - レスポンス: { data: [<生成テキスト>] }
// - 認証: Authorization: Bearer <key>
// - ストリーミング非対応 (set stream=true 不可、応答全体を待つ)
//
// 参考実装: https://github.com/whiteball/vscode-ai-novelist/blob/main/src/api.ts
// ---------------------------------------------------------------------------

/// 役割タグ付きで会話履歴を 1 つの text に平坦化する。
/// AI のべりすとはチャット履歴形式を受け付けないため、
/// `[system]\n...\n\n[user]\n...\n\n[assistant]\n...` のように連結する。
fn flatten_messages_for_ainoverist(messages: &[(&str, &str)]) -> String {
    messages
        .iter()
        .map(|(role, content)| format!("[{role}]\n{content}"))
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// AI のべりすと用リクエストボディを構築する。
/// `length` はモデル別の最大出力 (= TS 側 `AINOVERIST_MODEL_CAPS.maxOutputTokens`)。
/// API 側で必須なので必ず含める。`extra_body` は最後にマージするが、
/// `merge_extra_body` は既存キーを上書きしないため `length` は保護される。
fn build_ainoverist_body(
    model: &str,
    messages: &[(&str, &str)],
    extra_body: &Option<serde_json::Value>,
) -> serde_json::Value {
    let text = flatten_messages_for_ainoverist(messages);
    let mut body = serde_json::json!({
        "text": text,
        "model": model,
        "length": ai_novelist::length_for(model),
    });
    merge_extra_body(&mut body, extra_body);
    body
}

/// Chat API 用: messages を `[{role, content}]` 配列に変換する。
/// `system` ロールはチャット API で動作未検証のため、最初の非 system メッセージ先頭に結合する。
fn messages_to_chat_array(messages: &[(&str, &str)]) -> Vec<serde_json::Value> {
    let mut system_buf: Vec<&str> = Vec::new();
    let mut out: Vec<serde_json::Value> = Vec::new();
    for (role, content) in messages {
        if *role == "system" {
            system_buf.push(content);
        } else {
            let body = if !system_buf.is_empty() && out.is_empty() {
                let prefix = system_buf.join("\n\n");
                system_buf.clear();
                format!("{prefix}\n\n{content}")
            } else {
                (*content).to_string()
            };
            out.push(serde_json::json!({ "role": role, "content": body }));
        }
    }
    if !system_buf.is_empty() {
        out.push(serde_json::json!({
            "role": "user",
            "content": system_buf.join("\n\n"),
        }));
    }
    out
}

/// Chat API 用: `rep_pen` → `repetition_penalty` 等、Completion API と異なるキー名を変換する。
fn remap_extra_body_for_chat(extra_body: &Option<serde_json::Value>) -> Option<serde_json::Value> {
    let obj = extra_body.as_ref()?.as_object()?;
    let mut out = serde_json::Map::new();
    for (k, v) in obj {
        let new_key = match k.as_str() {
            "rep_pen" => "repetition_penalty",
            other => other,
        };
        out.insert(new_key.to_string(), v.clone());
    }
    Some(serde_json::Value::Object(out))
}

/// AI のべりすと Chat API 用リクエストボディを構築する。
fn build_ainoverist_chat_body(
    model: &str,
    messages: &[(&str, &str)],
    extra_body: &Option<serde_json::Value>,
) -> serde_json::Value {
    let msgs = messages_to_chat_array(messages);
    let mut body = serde_json::json!({
        "messages": msgs,
        "model": model,
        "max_tokens": ai_novelist::length_for(model),
    });
    let remapped = remap_extra_body_for_chat(extra_body);
    merge_extra_body(&mut body, &remapped);
    body
}

/// AI のべりすと用リクエストを構築・送信し、ChatResponse に変換する。
async fn send_chat_ainoverist(
    client: &reqwest::Client,
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
) -> anyhow::Result<ChatResponse> {
    let url = params.provider.base_url(params.endpoints);
    if url.is_empty() {
        return Err(anyhow::anyhow!(
            "AI のべりすと: base URL が設定されていません"
        ));
    }
    let body = match params.ai_novelist_mode {
        AiNovelistMode::Chat => {
            build_ainoverist_chat_body(params.model, messages, &params.extra_body)
        }
        AiNovelistMode::Completion => {
            build_ainoverist_body(params.model, messages, &params.extra_body)
        }
    };

    let req = client
        .post(&url)
        .header("content-type", "application/json")
        .header("Authorization", format!("Bearer {}", params.api_key))
        .json(&body);

    let resp = send_with_429_retry(req, params.retry_429, 3)
        .await?
        .error_for_status()?;
    let result: serde_json::Value = resp.json().await?;
    parse_ainoverist_response(&result)
}

/// `<think>…</think>` ブロックをすべて除去して前後の空白をトリムする。
/// 複数ブロック対応。閉じタグなしの場合はそこで打ち切り。
fn strip_think_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(rel_end) => rest = &rest[start + rel_end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn parse_ainoverist_response(result: &serde_json::Value) -> anyhow::Result<ChatResponse> {
    // 観測されているレスポンス形状:
    // (a) 旧/簡易: { "data": ["text"] }
    // (b) 旧/簡易: { "data": "text" }
    // (c) 現行 (vLLM 風 text_completion):
    //     { "data": { "0": "text",
    //                  "choices": [{ "text": "...", "finish_reason": "stop" }],
    //                  "usage": { "completion_tokens": N, "prompt_tokens": -1 } } }
    let data = result.get("data").ok_or_else(|| {
        anyhow::anyhow!(
            "AI のべりすと: レスポンスに data フィールドが見つかりません: {}",
            result
        )
    })?;

    let mut stop_reason = "end_turn".to_string();
    let mut input_tokens: Option<u64> = None;
    let mut output_tokens: Option<u64> = None;

    let text = if let Some(arr) = data.as_array() {
        arr.first()
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    } else if let Some(s) = data.as_str() {
        s.to_string()
    } else if let Some(obj) = data.as_object() {
        // choices[0].text を優先 (OpenAI text_completion 互換)。
        // Chat API では choices[0].text が空文字で data["0"] に本文が入るため、
        // 空文字は None 扱いにして data["0"] へフォールバックさせる。
        let from_choices = obj
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|first| {
                if let Some(reason) = first.get("finish_reason").and_then(|r| r.as_str()) {
                    stop_reason = reason.to_string();
                }
                first.get("text").and_then(|t| t.as_str())
            })
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        // フォールバック: data["0"] (Chat API レスポンスはここに本文が入る)
        from_choices.unwrap_or_else(|| {
            obj.get("0")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
    } else {
        return Err(anyhow::anyhow!(
            "AI のべりすと: data フィールドの形状が不正です: {}",
            result
        ));
    };

    // usage は data 内 (現行) または トップレベル (旧) のどちらかにあり得る。
    // -1 はサーバ側で未集計のセンチネルなので採用しない。
    let usage = data.get("usage").or_else(|| result.get("usage"));
    if let Some(u) = usage {
        input_tokens = u
            .get("input_tokens")
            .or_else(|| u.get("prompt_tokens"))
            .and_then(|v| v.as_i64())
            .filter(|n| *n >= 0)
            .map(|n| n as u64);
        output_tokens = u
            .get("output_tokens")
            .or_else(|| u.get("completion_tokens"))
            .and_then(|v| v.as_i64())
            .filter(|n| *n >= 0)
            .map(|n| n as u64);
    }

    let text = strip_think_blocks(&text);

    let blocks = if text.is_empty() {
        Vec::new()
    } else {
        vec![ResponseBlock::Text { content: text }]
    };
    Ok(ChatResponse {
        blocks,
        stop_reason,
        input_tokens,
        output_tokens,
        citations: Vec::new(),
        cost: None,
    })
}

/// `Retry-After` ヘッダから待機ミリ秒を取り出す。秒数 (整数) のみ対応。
/// 値が無い／パース不能なら None。
fn parse_retry_after_ms(resp: &reqwest::Response) -> Option<u64> {
    let header = resp.headers().get(reqwest::header::RETRY_AFTER)?;
    let s = header.to_str().ok()?;
    let secs: u64 = s.trim().parse().ok()?;
    Some(secs.saturating_mul(1000))
}

/// 429 を受けたときに指数バックオフでリトライするヘルパ。
/// `retry_enabled = false` のときはリトライせず初回応答を返す。
pub(crate) async fn send_with_429_retry(
    initial: reqwest::RequestBuilder,
    retry_enabled: bool,
    max_retries: u32,
) -> anyhow::Result<reqwest::Response> {
    let mut current = initial;
    let mut attempt: u32 = 0;
    loop {
        // try_clone は send 前にしかできないので、ループの先頭で次の試行用にクローン
        let next = if retry_enabled && attempt < max_retries {
            current.try_clone()
        } else {
            None
        };
        let resp = current.send().await?;
        if !retry_enabled || resp.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(resp);
        }
        let Some(c) = next else {
            // 残り試行回数なし。最後の 429 応答をそのまま返し、呼び出し側で
            // error_for_status などのハンドリングに任せる。
            return Ok(resp);
        };
        let wait_ms = parse_retry_after_ms(&resp).unwrap_or_else(|| {
            // 指数バックオフ: 1s, 2s, 4s
            1000u64 * (1u64 << attempt)
        });
        tokio::time::sleep(std::time::Duration::from_millis(wait_ms)).await;
        attempt += 1;
        current = c;
    }
}

/// OpenRouter の `provider.order` を固定するため、body に `provider` フィールドを注入する。
/// `pin` が None / 空文字 / provider が OpenRouter 以外の場合は何もしない。
/// 同一 provider に毎回ルーティングさせることで Anthropic prompt cache が効きやすくなる。
pub(crate) fn apply_openrouter_provider_pin(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    pin: Option<&str>,
) {
    if !matches!(provider, AiProvider::OpenRouter) {
        return;
    }
    let Some(slug) = pin else { return };
    let slug = slug.trim();
    if slug.is_empty() {
        return;
    }
    if let serde_json::Value::Object(target) = body {
        target.insert(
            "provider".to_string(),
            serde_json::json!({
                "order": [slug],
                "allow_fallbacks": true,
            }),
        );
    }
}

/// OpenRouter の Web 検索 (RAG) を body に注入する。/chat/completions の
/// `send_chat_with_tools` (Agent 経路) と同一ロジックで、Responses 経路からも
/// 呼べるよう切り出した共通実装。`ws.agentic` が true なら server tool
/// (`openrouter:web_search`) を `tools[]` へ、false なら web plugin を `plugins` へ。
/// ドメイン制御 / content cap が指定されたターンのみ engine=exa を強制する。
/// provider が OpenRouter 以外、または web_search が無効なら何もしない。
/// 注: Responses 経路は tool 定義が空のとき `tools` キーを省くため、agentic では
/// 配列が無ければ新規作成する(chat/completions は常に tools[] がある前提だった)。
pub(crate) fn apply_openrouter_web_search_to_body(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    web_search: Option<&WebSearchConfig>,
) {
    if !matches!(provider, AiProvider::OpenRouter) {
        return;
    }
    let Some(ws) = web_search else { return };
    if !ws.enabled {
        return;
    }
    let force_exa = ws.needs_exa_engine();
    if ws.agentic {
        let mut tool = serde_json::json!({ "type": "openrouter:web_search" });
        if force_exa {
            apply_openrouter_web_controls(&mut tool, ws);
        }
        if let Some(arr) = body["tools"].as_array_mut() {
            arr.push(tool);
        } else {
            body["tools"] = serde_json::json!([tool]);
        }
    } else {
        let mut plugin = serde_json::json!({
            "id": "web",
            "max_results": ws.results_cap()
        });
        if force_exa {
            apply_openrouter_web_controls(&mut plugin, ws);
        }
        body["plugins"] = serde_json::json!([plugin]);
    }
}

/// OpenRouter Fusion (マルチモデル合議) のカスタム構成を body に注入する。
/// provider が OpenRouter かつ model が `"openrouter/fusion"`、かつ `fusion.enabled` で
/// panel / judge のいずれかが指定されているときだけ
/// `plugins:[{id:"fusion", analysis_models?, model?}]` を**追加**する
/// (既存の web plugin 等は壊さない)。それ以外は何もしない —
/// 素の `openrouter/fusion` は OpenRouter 既定パネルでそのまま動く。
pub(crate) fn apply_openrouter_fusion_to_body(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    model: &str,
    fusion: Option<&FusionConfig>,
) {
    if !matches!(provider, AiProvider::OpenRouter) {
        return;
    }
    if model != "openrouter/fusion" {
        return;
    }
    let Some(f) = fusion else { return };
    if !f.enabled {
        return;
    }
    let analysis: Vec<String> = f
        .analysis_models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    let judge = f
        .judge_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // 構成が実質空 → 既定パネルに委ねる (plugin 不要)。
    if analysis.is_empty() && judge.is_none() {
        return;
    }
    let mut plugin = serde_json::Map::new();
    plugin.insert("id".to_string(), serde_json::json!("fusion"));
    if !analysis.is_empty() {
        plugin.insert("analysis_models".to_string(), serde_json::json!(analysis));
    }
    if let Some(j) = judge {
        plugin.insert("model".to_string(), serde_json::json!(j));
    }
    let plugin = serde_json::Value::Object(plugin);
    if let Some(arr) = body["plugins"].as_array_mut() {
        arr.push(plugin);
    } else {
        body["plugins"] = serde_json::json!([plugin]);
    }
}

/// `params.extra_body` をリクエストボディにマージする。
/// `body` がオブジェクトでない場合は何もしない。
pub(crate) fn merge_extra_body(body: &mut serde_json::Value, extra: &Option<serde_json::Value>) {
    let Some(serde_json::Value::Object(map)) = extra.clone() else {
        return;
    };
    if let serde_json::Value::Object(target) = body {
        for (k, v) in map {
            // 既存キーを上書きしない（プロバイダ固有のサンプリングが事故で
            // model / messages 等を破壊しないよう保護）
            target.entry(k).or_insert(v);
        }
    }
}

/// Send a chat completion request with the given messages.
/// Messages are tuples of (role, content). Supports "system", "user", "assistant" roles.
/// 送信経路のパンくずを INFO で1行出す(本文を含まないので常時オンでも安全)。
/// 「fusion が responses 経路に逃げていた」等の経路起因バグを、本文ダンプ
/// (`GRIMODEX_AI_WIRE_LOG`)を有効化せずともログ1行で切り分けられるようにする。
/// 既定フィルタ `grimodex_lib=info` で出る(module-path target)。route は実際に通る
/// API 経路、fusion は plugin が注入される条件を満たすか。
fn log_ai_route(surface: &str, params: &ChatParams<'_>, tool_count: usize) {
    let route = if crate::ai_responses::uses_responses_api(
        params.provider,
        params.api_variant.as_deref(),
    ) {
        "responses"
    } else {
        "chat_completions"
    };
    let fusion_active = matches!(params.provider, AiProvider::OpenRouter)
        && params.model == "openrouter/fusion"
        && params.fusion.map(|f| f.enabled).unwrap_or(false);
    tracing::info!(
        "AI route: surface={surface} route={route} provider={:?} model={} variant={} tools={tool_count} fusion={fusion_active}",
        params.provider,
        params.model,
        params.api_variant.as_deref().unwrap_or("-")
    );
}

pub async fn send_chat(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();
    log_ai_route("send_chat", params, 0);

    // AI のべりすと legacy は独自フォーマット。v1 は OpenAI 互換分岐へ合流。
    if matches!(params.provider, AiProvider::AiNovelist) && !is_ainoverist_v1(params) {
        return send_chat_ainoverist(&client, params, messages).await;
    }

    // OpenAI Responses API (/v1/responses) 経路。OpenAI 直 / 互換 gateway で
    // api_variant=="responses" のとき chat/completions ではなく Responses 形式で送る。
    if crate::ai_responses::uses_responses_api(params.provider, params.api_variant.as_deref()) {
        return crate::ai_responses::send(params, messages).await;
    }

    match params.provider {
        AiProvider::Anthropic => {
            let (system_content, chat_messages) = split_system_messages(messages);

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
            });
            let system_payload = build_system_payload(
                params.provider,
                params.model,
                &system_content,
                params.system_cache_segments.as_deref(),
                params.system_volatile_tail.as_deref(),
            );
            if !system_content.is_empty() || params.system_cache_segments.is_some() {
                body["system"] = system_payload;
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_send(anthropic_request(&client, params, &body)).await?;
            let result: serde_json::Value = resp.json().await?;
            parse_anthropic_response(&result)
        }
        _ => {
            // OpenRouter + Claude では system に cache_control を載せて prompt cache を効かせる。
            let chat_messages = build_openai_chat_messages(
                messages,
                params.provider,
                params.model,
                params.system_cache_segments.as_deref(),
                params.system_volatile_tail.as_deref(),
            );

            let mut body = serde_json::json!({
                "model": params.model,
                "messages": chat_messages,
            });
            insert_chat_completion_token_limit(
                &mut body,
                params.provider,
                openai_max_tokens(params),
            );
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.model,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );
            apply_openrouter_fusion_to_body(
                &mut body,
                params.provider,
                params.model,
                params.fusion,
            );

            let req = openai_compat_request(&client, params, &body);
            let resp = send_with_429_retry(req, params.retry_429, 3)
                .await?
                .error_for_status()?;
            let result: serde_json::Value = resp.json().await?;
            // 非 tools chat: ToolUse は生成しない (allowed 空)。Hermes 時のみ本文タグを strip。
            parse_openai_response(
                &result,
                &ParseOpenAIOptions {
                    resolved_protocol: params.resolved_tool_protocol,
                    allowed_tool_names: Vec::new(),
                    block_mutating_on_native: false,
                },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// Agent / Tool Use types
// ---------------------------------------------------------------------------

/// A tool_use block inside an assistant message (multi-turn conversation).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ToolUsePayload {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

/// Normalized message format for agent conversations.
/// The `role` field acts as a discriminant tag.
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "role")]
pub enum AgentMessage {
    #[serde(rename = "user")]
    User { content: String },
    #[serde(rename = "system")]
    System { content: String },
    #[serde(rename = "assistant", rename_all = "camelCase")]
    Assistant {
        content: String,
        #[serde(default)]
        tool_uses: Vec<ToolUsePayload>,
        /// thinking ブロック（signature 付き）。マルチターン会話で API に返す必要がある。
        #[serde(default)]
        thinking_blocks: Vec<ThinkingPayload>,
    },
    #[serde(rename = "tool_result", rename_all = "camelCase")]
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// Normalized tool definition sent by the frontend.
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

/// A block in a structured LLM response.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponseBlock {
    Text {
        content: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    Thinking {
        content: String,
        summary: Option<String>,
        signature: Option<String>,
    },
}

/// thinking ブロック（マルチターン会話で assistant メッセージに含めるもの）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ThinkingPayload {
    pub thinking: String,
    pub signature: String,
}

/// Thinking パラメータ設定（設計書 L627-647 準拠）
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThinkingConfig {
    /// Opus 4.6 / Sonnet 4.6: adaptive thinking
    Adaptive {
        effort: String,
        display: Option<String>,
    },
    /// Opus 4.5 / Sonnet 4.5: budget_tokens
    Enabled {
        budget_tokens: u32,
        display: Option<String>,
    },
}

/// Web 検索の引用 (共通正規化形)。各プロバイダの引用フォーマット差
/// (Anthropic `web_search_result_location` / OpenRouter `url_citation`) を
/// この形に吸収してから FE に渡す (設計書 §0-2 / §5-3 / §6-4)。
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    pub url: String,
    pub title: String,
    /// 回答中で引用された抜粋。
    pub cited_text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snippet: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub published_date: Option<String>,
}

/// Structured response returned from `send_chat_with_tools`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub blocks: Vec<ResponseBlock>,
    pub stop_reason: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// Web 検索の引用 (RAG 無効時は空)。
    #[serde(default)]
    pub citations: Vec<Citation>,
    /// このリクエストの概算コスト (USD)。OpenRouter は `usage.cost` を
    /// そのまま返す。直叩きは None (FE 側で modelPricing から概算)。
    #[serde(default)]
    pub cost: Option<f64>,
}

/// プロバイダ別の usage オブジェクトから prompt cache のトークン数を取り出す。
/// 戻り値は `(cache_read_tokens, cache_write_tokens)`。
///
/// プロバイダごとに会計モデルが異なる (この差をここ 1 箇所に閉じ込める):
/// - Anthropic 直叩き: `usage.cache_read_input_tokens` / `cache_creation_input_tokens`。
///   `input_tokens` は **キャッシュ分を含まない** (合計 = input + read + creation)。
/// - OpenRouter / OpenAI 互換: `usage.prompt_tokens_details.cached_tokens` /
///   `cache_write_tokens`。`prompt_tokens` は **キャッシュ読込分を含む** (cached ⊆ prompt)。
///
/// `cache_write_tokens` (OpenAI 形) は実在が未確定なフィールドなので、欠落時は
/// None で素通しする (read だけ取れれば計測の主信号としては十分)。
fn extract_cache_tokens(
    usage: &serde_json::Value,
    provider: &AiProvider,
) -> (Option<u64>, Option<u64>) {
    if matches!(provider, AiProvider::Anthropic) {
        let read = usage["cache_read_input_tokens"].as_u64();
        let write = usage["cache_creation_input_tokens"].as_u64();
        (read, write)
    } else {
        let details = &usage["prompt_tokens_details"];
        let read = details["cached_tokens"].as_u64();
        let write = details["cache_write_tokens"].as_u64();
        (read, write)
    }
}

/// 同一 URL の重複を避けて引用を追加する (1 ソース = 1 エントリ)。
pub(crate) fn push_unique_citation(citations: &mut Vec<Citation>, cit: Citation) {
    if !cit.url.is_empty() && !citations.iter().any(|c| c.url == cit.url) {
        citations.push(cit);
    }
}

/// Anthropic `web_search_result_location` を共通形へ変換する。
fn parse_anthropic_citation(c: &serde_json::Value) -> Option<Citation> {
    let url = c["url"].as_str()?.to_string();
    if url.is_empty() {
        return None;
    }
    Some(Citation {
        title: c["title"].as_str().unwrap_or("").to_string(),
        cited_text: c["cited_text"].as_str().unwrap_or("").to_string(),
        url,
        snippet: None,
        published_date: None,
    })
}

fn parse_anthropic_response(result: &serde_json::Value) -> anyhow::Result<ChatResponse> {
    let stop_reason = result["stop_reason"]
        .as_str()
        .unwrap_or("end_turn")
        .to_string();
    let mut blocks = Vec::new();
    let mut citations: Vec<Citation> = Vec::new();

    if let Some(content) = result["content"].as_array() {
        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or("").to_string();
                    if !text.is_empty() {
                        blocks.push(ResponseBlock::Text { content: text });
                    }
                    // web_search 使用時、text ブロックに citations 配列が付く。
                    // server_tool_use / web_search_tool_result ブロックは
                    // プロバイダがサーバ側で解決済みのため無視 (`_ =>`)。
                    if let Some(cites) = block["citations"].as_array() {
                        for c in cites {
                            if let Some(cit) = parse_anthropic_citation(c) {
                                push_unique_citation(&mut citations, cit);
                            }
                        }
                    }
                }
                Some("tool_use") => {
                    let id = block["id"].as_str().unwrap_or("").to_string();
                    let name = block["name"].as_str().unwrap_or("").to_string();
                    let input = block["input"].clone();
                    blocks.push(ResponseBlock::ToolUse { id, name, input });
                }
                Some("thinking") => {
                    let content = block["thinking"].as_str().unwrap_or("").to_string();
                    let summary = block["summary"].as_str().map(|s| s.to_string());
                    let signature = block["signature"].as_str().map(|s| s.to_string());
                    blocks.push(ResponseBlock::Thinking {
                        content,
                        summary,
                        signature,
                    });
                }
                _ => {}
            }
        }
    }

    let input_tokens = result["usage"]["input_tokens"].as_u64();
    let output_tokens = result["usage"]["output_tokens"].as_u64();

    Ok(ChatResponse {
        blocks,
        stop_reason,
        input_tokens,
        output_tokens,
        citations,
        // Anthropic 直叩きは usage.cost を返さない。FE で modelPricing 概算。
        cost: None,
    })
}

/// Mutating agent tools that must never be invoked via the Hermes body-text
/// `<tool_call>` channel. A Web-search result echoed into the assistant body as
/// a `<tool_call>` is indistinguishable from a genuine model call, so allowing
/// writes there is an injection-driven write vector (and the only backstop,
/// AiPolicy, fail-opens to all-writes on a fresh project).
///
/// The same list is reused for the **native** `tool_calls` channel, but only for
/// low-trust providers (`is_low_trust_native_provider`). Native providers carry
/// tool calls in a structured field separate from body text, so a frontier model
/// is largely safe; but a weak local model can be coerced by indirect injection
/// into *emitting* a native mutating tool_call, so for local/unverified
/// OpenAI-compatible providers we block these names on the native path too
/// (see `ParseOpenAIOptions::block_mutating_on_native`).
///
/// Must stay in sync with `MUTATING_TOOL_NAMES` in
/// src/features/chat/toolProtocolParse.ts.
pub(crate) const HERMES_BLOCKED_TOOL_NAMES: &[&str] = &[
    "create_codex_entry",
    "update_codex_entry",
    "create_foreshadow",
    "update_foreshadow",
    "create_snippet",
    "apply_ai_tree_plan",
    "propose_scene_body",
];

/// Declared tool names minus mutating ones — the Hermes body-channel allow-list
/// (write block). Native tool_use is built elsewhere and is unaffected.
fn hermes_allowed_tool_names(tools: &[AgentToolDef]) -> Vec<String> {
    tools
        .iter()
        .map(|t| t.name.clone())
        .filter(|n| !HERMES_BLOCKED_TOOL_NAMES.contains(&n.as_str()))
        .collect()
}

/// `parse_openai_response` の挙動を制御するオプション。
struct ParseOpenAIOptions {
    resolved_protocol: ResolvedToolProtocol,
    /// Hermes パースで ToolUse 化を許可するツール名。空なら ToolUse を生成しない。
    allowed_tool_names: Vec<String>,
    /// native `tool_calls` 経路で mutating ツール（`HERMES_BLOCKED_TOOL_NAMES`）を
    /// ToolUse 化せず破棄するか。低信頼プロバイダ（`is_low_trust_native_provider`）
    /// のときだけ true。frontier では false=従来どおり全許可。
    block_mutating_on_native: bool,
}

impl Default for ParseOpenAIOptions {
    fn default() -> Self {
        Self {
            resolved_protocol: ResolvedToolProtocol::Native,
            allowed_tool_names: Vec::new(),
            block_mutating_on_native: false,
        }
    }
}

/// 本文から抽出した 1 件の Hermes ツール呼び出し。
struct HermesToolCall {
    id: String,
    name: String,
    input: serde_json::Value,
}

/// `<tag>…</tag>` ブロックをすべて除去。閉じタグ無しは以降を打ち切り
/// (`strip_think_blocks` / TS `stripTagBlocks` と同セマンティクス)。
fn strip_tag_blocks(text: &str, tag: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find(&open) {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        match after.find(&close) {
            Some(rel) => rest = &after[rel + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

/// 3 連以上の改行を 2 連へ畳む (TS `replace(/\n{3,}/g, "\n\n")` 相当)。
fn collapse_blank_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0usize;
    for ch in s.chars() {
        if ch == '\n' {
            run += 1;
            if run <= 2 {
                out.push('\n');
            }
        } else {
            run = 0;
            out.push(ch);
        }
    }
    out
}

/// 本文から `<tool_call>` / `<tool_response>` を除去し連続空行を畳んで trim。
/// `stripToolProtocol` (TS) と同セマンティクス。
fn strip_hermes_tool_blocks(text: &str) -> String {
    let stripped = strip_tag_blocks(text, "tool_call");
    let stripped = strip_tag_blocks(&stripped, "tool_response");
    collapse_blank_lines(&stripped).trim().to_string()
}

/// `arguments` / `input` を object へ正規化 (object も stringified JSON も許容)。
fn coerce_args(raw: &serde_json::Value) -> serde_json::Value {
    let empty = || serde_json::Value::Object(Default::default());
    match raw {
        serde_json::Value::Object(_) => raw.clone(),
        serde_json::Value::String(s) => serde_json::from_str::<serde_json::Value>(s)
            .ok()
            .filter(|v| v.is_object())
            .unwrap_or_else(empty),
        _ => empty(),
    }
}

/// 本文から `<tool_call>{...}</tool_call>` を抽出する。
/// - `name` が `allowed` に一致するものだけ合成 ID 付きで返す。
/// - 壊れた JSON・未知ツール・未閉じタグは呼び出しにしない (タグは strip 側で除去)。
/// - `arguments` / `input` 両キー対応。`arguments` が stringified JSON でも可。
fn parse_hermes_tool_calls(content: &str, allowed: &[String]) -> (String, Vec<HermesToolCall>) {
    let stripped = strip_hermes_tool_blocks(content);
    let mut calls: Vec<HermesToolCall> = Vec::new();
    if content.is_empty() || allowed.is_empty() {
        return (stripped, calls);
    }
    let open = "<tool_call>";
    let close = "</tool_call>";
    let mut rest = content;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let rel = match after.find(close) {
            Some(r) => r,
            None => break, // 未閉じ: 以降は捨てる。
        };
        let inner = after[..rel].trim();
        rest = &after[rel + close.len()..];

        let obj: serde_json::Value = match serde_json::from_str(inner) {
            Ok(v) => v,
            Err(_) => continue, // 壊れた JSON はスキップ。
        };
        let name = obj["name"].as_str().unwrap_or("");
        if name.is_empty() || !allowed.iter().any(|n| n == name) {
            continue;
        }
        let raw_args = if obj.get("arguments").is_some() {
            &obj["arguments"]
        } else {
            &obj["input"]
        };
        calls.push(HermesToolCall {
            id: format!("hermes-{}", calls.len()),
            name: name.to_string(),
            input: coerce_args(raw_args),
        });
    }
    (stripped, calls)
}

// --- Hermes 送信側エンコード (Phase B) ---
//
// 背景 (実測): OpenRouter は tool 非対応エンドポイントのモデルに OpenAI `tools[]`
// を送ると 404 "No endpoints found that support tool use" を返す。Hermes 系は
// native tool 非対応ゆえ本文 <tool_call> を吐くので、Hermes 解決時は tools[] を
// 送らず、ツール定義を <tools> system XML として注入する。

/// assistant 履歴の tool use を `<tool_call>` テキストへエンコードする。
fn format_hermes_tool_call(name: &str, input: &serde_json::Value) -> String {
    format!(
        "<tool_call>\n{}\n</tool_call>",
        serde_json::json!({ "name": name, "arguments": input })
    )
}

/// tool result を `<tool_response>` テキストへエンコードする。
fn format_hermes_tool_response(name: &str, content: &str, is_error: bool) -> String {
    let mut payload = serde_json::json!({ "name": name, "content": content });
    if is_error {
        payload["is_error"] = serde_json::json!(true);
    }
    format!("<tool_response>\n{payload}\n</tool_response>")
}

/// Nous Hermes 標準の function-calling system プロンプト断片を組む。
/// `<tools>` に各ツールの JSON schema を列挙する。
fn build_hermes_tools_preamble(tools: &[AgentToolDef]) -> String {
    let lines: Vec<String> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema
            })
            .to_string()
        })
        .collect();
    format!(
        "You are a function calling AI model. You are provided with function signatures within \
<tools></tools> XML tags. You may call one or more functions to assist with the user query. \
Don't make assumptions about what values to plug into functions. \
Here are the available tools:\n<tools>\n{}\n</tools>\n\
For each function call, return a json object with the function name and arguments within \
<tool_call></tool_call> XML tags, like:\n<tool_call>\n{{\"name\": <function-name>, \
\"arguments\": <args-dict>}}\n</tool_call>\n\
The tool result is returned within <tool_response></tool_response> tags. \
Only call tools listed above.",
        lines.join("\n")
    )
}

/// Hermes プロトコル用に OpenAI 互換 messages 配列を組む (純関数・テスト対象)。
/// - `tools[]` は body に載せない (caller が省略)。代わりに `<tools>` を最初の
///   system へ注入 (system が無ければ先頭に system を追加)。
/// - assistant の tool_uses を `<tool_call>` テキストへ、tool_result を
///   role:"user" の `<tool_response>` テキストへ変換 (native tool_calls / role:"tool"
///   は使わない=tools[] 不在で orphan になり弾かれるため)。
fn build_hermes_openai_messages(
    messages: &[AgentMessage],
    tools: &[AgentToolDef],
) -> Vec<serde_json::Value> {
    let preamble = build_hermes_tools_preamble(tools);
    let mut out: Vec<serde_json::Value> = Vec::new();
    // tool_use_id -> name (ToolResult の <tool_response> に name を載せるため)。
    let mut name_by_id: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut preamble_applied = false;

    for msg in messages {
        match msg {
            AgentMessage::User { content } => {
                out.push(serde_json::json!({ "role": "user", "content": content }));
            }
            AgentMessage::System { content } => {
                let merged = if !preamble_applied {
                    preamble_applied = true;
                    format!("{content}\n\n{preamble}")
                } else {
                    content.clone()
                };
                out.push(serde_json::json!({ "role": "system", "content": merged }));
            }
            AgentMessage::Assistant {
                content, tool_uses, ..
            } => {
                for tu in tool_uses {
                    name_by_id.insert(tu.id.clone(), tu.name.clone());
                }
                if tool_uses.is_empty() {
                    out.push(serde_json::json!({ "role": "assistant", "content": content }));
                } else {
                    let mut text = content.clone();
                    for tu in tool_uses {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&format_hermes_tool_call(&tu.name, &tu.input));
                    }
                    out.push(serde_json::json!({ "role": "assistant", "content": text }));
                }
            }
            AgentMessage::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                let name = name_by_id
                    .get(tool_use_id)
                    .map(|s| s.as_str())
                    .unwrap_or("");
                out.push(serde_json::json!({
                    "role": "user",
                    "content": format_hermes_tool_response(name, content, *is_error)
                }));
            }
        }
    }

    // system が一度も無ければ先頭に <tools> 入り system を追加する。
    if !preamble_applied {
        out.insert(
            0,
            serde_json::json!({ "role": "system", "content": preamble }),
        );
    }
    out
}

/// AI リクエスト/レスポンス本文のデバッグログを有効化するか。
/// 本文には小説本文 (私的テキスト) が含まれるため、env var で明示有効時のみ出力。
pub(crate) fn ai_wire_log_enabled() -> bool {
    std::env::var("GRIMODEX_AI_WIRE_LOG")
        .map(|v| v != "0" && !v.is_empty())
        .unwrap_or(false)
}

/// ログ用に文字列を char 境界で切り詰める。
pub(crate) fn truncate_for_log(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    let omitted = s.chars().count() - max;
    format!("{head}…[+{omitted} chars]")
}

fn parse_openai_response(
    result: &serde_json::Value,
    opts: &ParseOpenAIOptions,
) -> anyhow::Result<ChatResponse> {
    let choice = &result["choices"][0];
    let finish_reason = choice["finish_reason"].as_str().unwrap_or("stop");
    let mut stop_reason = if finish_reason == "tool_calls" {
        "tool_use"
    } else {
        "end_turn"
    }
    .to_string();

    let mut blocks = Vec::new();
    let message = &choice["message"];

    // Ollama: message.thinking フィールド
    if let Some(thinking) = message["thinking"].as_str() {
        if !thinking.is_empty() {
            blocks.push(ResponseBlock::Thinking {
                content: thinking.to_string(),
                summary: None,
                signature: None,
            });
        }
    }

    // OpenRouter は message.reasoning が canonical、reasoning_content は alias。
    // 両方読み、空でない最初のものを採用する（重複 push を防ぐ）。
    let reasoning_text = message["reasoning"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            message["reasoning_content"]
                .as_str()
                .filter(|s| !s.is_empty())
        });
    if let Some(reasoning) = reasoning_text {
        blocks.push(ResponseBlock::Thinking {
            content: reasoning.to_string(),
            summary: None,
            signature: None,
        });
    }

    let native_tool_calls = message["tool_calls"]
        .as_array()
        .filter(|arr| !arr.is_empty());
    let content = message["content"].as_str().unwrap_or("");

    // 本文 Text と ToolUse の決定。優先順:
    //   1. native tool_calls があれば native のみ (本文 Hermes パースはスキップ=二重実行防止)
    //   2. Hermes プロトコルなら本文 <tool_call> を抽出 (allowed 一致のみ ToolUse)
    //   3. それ以外は本文をそのまま Text に
    if let Some(tool_calls) = native_tool_calls {
        if !content.is_empty() {
            blocks.push(ResponseBlock::Text {
                content: content.to_string(),
            });
        }
        let mut native_tool_uses = 0usize;
        for tc in tool_calls {
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            // 低信頼プロバイダでは native channel の mutating ツールも破棄する
            // (Hermes 本文経路 ai.rs:parse_hermes_tool_calls と対称の silent drop)。
            if opts.block_mutating_on_native && HERMES_BLOCKED_TOOL_NAMES.contains(&name.as_str()) {
                continue;
            }
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let input: serde_json::Value = serde_json::from_str(args_str)
                .unwrap_or(serde_json::Value::Object(Default::default()));
            blocks.push(ResponseBlock::ToolUse { id, name, input });
            native_tool_uses += 1;
        }
        // 全 tool_call が drop され ToolUse が 0 になったら、tool_use 昇格を取り消す
        // (finish_reason="tool_calls" 由来の stop_reason="tool_use" を end_turn に戻す)。
        if native_tool_uses == 0 {
            stop_reason = "end_turn".to_string();
        }
    } else if opts.resolved_protocol == ResolvedToolProtocol::Hermes {
        let (stripped, calls) = parse_hermes_tool_calls(content, &opts.allowed_tool_names);
        if !stripped.is_empty() {
            blocks.push(ResponseBlock::Text { content: stripped });
        }
        if !calls.is_empty() {
            // finish_reason が "stop" でも、本文ツール呼び出しがあれば tool_use 扱い。
            stop_reason = "tool_use".to_string();
            for c in calls {
                blocks.push(ResponseBlock::ToolUse {
                    id: c.id,
                    name: c.name,
                    input: c.input,
                });
            }
        }
    } else if !content.is_empty() {
        blocks.push(ResponseBlock::Text {
            content: content.to_string(),
        });
    }

    // OpenRouter web plugin / server tool は引用を `message.annotations` の
    // `url_citation` 形式で統一して返す (web plugin / native どちらも同形)。
    let mut citations: Vec<Citation> = Vec::new();
    if let Some(annotations) = message["annotations"].as_array() {
        for ann in annotations {
            if ann["type"].as_str() != Some("url_citation") {
                continue;
            }
            let uc = &ann["url_citation"];
            if let Some(url) = uc["url"].as_str() {
                push_unique_citation(
                    &mut citations,
                    Citation {
                        url: url.to_string(),
                        title: uc["title"].as_str().unwrap_or("").to_string(),
                        cited_text: uc["content"].as_str().unwrap_or("").to_string(),
                        snippet: None,
                        published_date: None,
                    },
                );
            }
        }
    }

    let input_tokens = result["usage"]["prompt_tokens"].as_u64();
    let output_tokens = result["usage"]["completion_tokens"].as_u64();
    // OpenRouter は usage.cost (USD) を返す。他の OpenAI 互換は通常返さない。
    let cost = result["usage"]["cost"].as_f64();

    Ok(ChatResponse {
        blocks,
        stop_reason,
        input_tokens,
        output_tokens,
        citations,
        cost,
    })
}

/// Ollama / OpenRouter / OpenAI 直叩き / AI のべりすと v1 向け reasoning パラメータを適用する。
fn apply_reasoning_to_body(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    api_variant: Option<&str>,
    model: &str,
    reasoning_enabled: Option<bool>,
    reasoning_effort: &Option<String>,
) {
    if matches!(provider, AiProvider::Ollama) {
        if let Some(enabled) = reasoning_enabled {
            body["think"] = serde_json::Value::Bool(enabled);
        }
    }

    if matches!(provider, AiProvider::OpenRouter) {
        if let Some(enabled) = reasoning_enabled {
            if enabled {
                let effort = match reasoning_effort.as_deref() {
                    Some("max") => "xhigh",
                    Some(e) => e,
                    None => "medium",
                };
                body["reasoning"] = serde_json::json!({ "effort": effort });
            } else {
                body["reasoning"] = serde_json::json!({ "effort": "none" });
            }
        }
    }

    // OpenAI 直叩き: reasoning_effort (文字列)。OpenRouter の reasoning オブジェクトとは別形式。
    if matches!(provider, AiProvider::OpenAI) {
        match reasoning_enabled {
            Some(true) => {
                let effort = match reasoning_effort.as_deref() {
                    // TS 側 EffortLevel に xhigh/minimal は無い。max は high に丸める。
                    Some("max") => "high",
                    Some(e @ ("low" | "medium" | "high")) => e,
                    _ => "medium",
                };
                // gpt-5-pro は high 固定 (low/medium は 400)。FE でも clamp するが Rust でも保険。
                let effort = if openai_model_requires_high_effort(model) {
                    "high"
                } else {
                    effort
                };
                body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
            }
            // OFF は none 対応モデル (gpt-5.1+) のみ。o3/gpt-5 等には disabling を送らない。
            Some(false) if openai_model_supports_reasoning_none(model) => {
                body["reasoning_effort"] = serde_json::Value::String("none".to_string());
            }
            _ => {}
        }
    }

    if matches!(provider, AiProvider::AiNovelist)
        && api_variant == Some("v1")
        && reasoning_enabled == Some(true)
    {
        let effort = match reasoning_effort.as_deref() {
            Some("max") => "high",
            Some(e @ ("low" | "medium" | "high")) => e,
            _ => "medium",
        };
        body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
    }
}

/// Anthropic Messages API: effort は `output_config.effort` に置く (thinking 内 / top-level 不可)。
fn set_output_config_effort(body: &mut serde_json::Value, effort: &str) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    let output_config = obj
        .entry("output_config")
        .or_insert_with(|| serde_json::json!({}));
    if let Some(oc) = output_config.as_object_mut() {
        oc.insert("effort".into(), serde_json::json!(effort));
    }
}

/// thinking / effort パラメータを Anthropic リクエストボディに適用する。
fn apply_thinking_to_body(
    body: &mut serde_json::Value,
    thinking: &Option<ThinkingConfig>,
    effort: &Option<String>,
) {
    match thinking {
        Some(ThinkingConfig::Adaptive {
            effort: t_effort,
            display,
        }) => {
            let mut thinking_obj = serde_json::json!({ "type": "adaptive" });
            if let Some(d) = display {
                thinking_obj["display"] = serde_json::Value::String(d.clone());
            }
            body["thinking"] = thinking_obj;
            set_output_config_effort(body, t_effort);
        }
        Some(ThinkingConfig::Enabled {
            budget_tokens,
            display,
        }) => {
            let mut thinking_obj = serde_json::json!({
                "type": "enabled",
                "budget_tokens": budget_tokens
            });
            if let Some(d) = display {
                thinking_obj["display"] = serde_json::Value::String(d.clone());
            }
            body["thinking"] = thinking_obj;
            if let Some(e) = effort {
                set_output_config_effort(body, e);
            }
        }
        None => {
            if let Some(e) = effort {
                set_output_config_effort(body, e);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Provider request helpers (private)
//
// Anthropic と OpenAI 互換系で完全に同じ HTTP セットアップを `send_chat` /
// `send_chat_with_tools` / `send_chat_stream` の3箇所で繰り返していたため、
// ヘッダ付与・URL 組み立て・system 分離をここに集約する。
// 公開 API のシグネチャは変えない（挙動は完全に等価）。
// ---------------------------------------------------------------------------

/// Anthropic beta ヘッダー文字列を組み立てる (reqwest は同名ヘッダ上書きのためカンマ結合)。
fn anthropic_beta_headers(params: &ChatParams<'_>) -> Option<String> {
    let mut betas: Vec<&str> = Vec::new();
    if params
        .system_cache_segments
        .as_ref()
        .is_some_and(|s| s.iter().any(|x| !x.is_empty()))
    {
        betas.push("prompt-caching-2024-07-31");
    }
    // Adaptive 4.6 は interleaved thinking が GA。manual (budget_tokens) 4.5 のみ beta 要。
    if matches!(params.thinking, Some(ThinkingConfig::Enabled { .. })) {
        betas.push("interleaved-thinking-2025-05-14");
    }
    if betas.is_empty() {
        None
    } else {
        Some(betas.join(","))
    }
}

fn parse_anthropic_http_error(status: reqwest::StatusCode, body_text: &str) -> anyhow::Error {
    let detail = serde_json::from_str::<serde_json::Value>(body_text)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(String::from))
        .unwrap_or_else(|| body_text.to_string());
    anyhow::anyhow!("AI request failed ({}): {}", status.as_u16(), detail.trim())
}

async fn anthropic_send(req: reqwest::RequestBuilder) -> anyhow::Result<reqwest::Response> {
    let resp = req.send().await?;
    if resp.status().is_success() {
        Ok(resp)
    } else {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        Err(parse_anthropic_http_error(status, &body_text))
    }
}

/// Build a POST request to Anthropic's `/messages` endpoint with required
/// headers (`x-api-key`, `anthropic-version`, `content-type`) and optional
/// `anthropic-beta` (prompt cache / interleaved thinking for manual mode).
fn anthropic_request(
    client: &reqwest::Client,
    params: &ChatParams<'_>,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let url = format!("{}/messages", params.provider.base_url(params.endpoints));
    let mut req = client
        .post(url)
        .header("x-api-key", params.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json");
    if let Some(betas) = anthropic_beta_headers(params) {
        req = req.header("anthropic-beta", betas);
    }
    req.json(body)
}

/// Build a POST request to an OpenAI-compatible `/chat/completions` endpoint
/// (OpenAI / OpenRouter / Ollama / OpenaiCompatible / AiNovelist v1).
fn openai_compat_request(
    client: &reqwest::Client,
    params: &ChatParams<'_>,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let url = format!(
        "{}/chat/completions",
        params
            .provider
            .openai_compat_base_url(params.endpoints, params.api_variant.as_deref())
    );
    let mut req = client.post(url).header("content-type", "application/json");
    let needs_auth = match params.provider {
        AiProvider::Ollama => false,
        AiProvider::OpenaiCompatible => !params.api_key.is_empty(),
        _ => true,
    };
    if needs_auth {
        req = req.header("Authorization", format!("Bearer {}", params.api_key));
    }
    if matches!(params.provider, AiProvider::OpenRouter) {
        req = req
            .header("HTTP-Referer", "https://github.com/kazormia296/Grimodex")
            .header("X-Title", "Grimodex");
    }
    req.json(body)
}

/// Split `(role, content)` tuples into Anthropic's two-part shape:
/// joined system content and the non-system messages as JSON values.
fn split_system_messages(messages: &[(&str, &str)]) -> (String, Vec<serde_json::Value>) {
    let system_content: String = messages
        .iter()
        .filter(|(role, _)| *role == "system")
        .map(|(_, content)| *content)
        .collect::<Vec<_>>()
        .join("\n");
    let chat_messages: Vec<serde_json::Value> = messages
        .iter()
        .filter(|(role, _)| *role != "system")
        .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
        .collect();
    (system_content, chat_messages)
}

/// Send a tool-aware chat request and return a structured response.
/// Anthropic native web_search ツールのバージョン識別子。
/// 設計書 §1 / §6-2 が指す最新版 (動的ドメインフィルタ対応)。
/// 万一アカウントで未対応なら旧安定版 `web_search_20250305` に差し替える。
const ANTHROPIC_WEB_SEARCH_TYPE: &str = "web_search_20260209";

pub async fn send_chat_with_tools(
    params: &ChatParams<'_>,
    messages: &[AgentMessage],
    tools: &[AgentToolDef],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();
    log_ai_route("send_chat_with_tools", params, tools.len());

    // AI のべりすと legacy は tool use 非対応。v1 は OpenAI 互換分岐へ合流。
    if matches!(params.provider, AiProvider::AiNovelist) && !is_ainoverist_v1(params) {
        return Err(anyhow::anyhow!(
            "AI のべりすと (legacy) は Tool Use に対応していません"
        ));
    }

    if matches!(params.provider, AiProvider::Cli) {
        return Err(anyhow::anyhow!(
            "CLI プロバイダは Agent（ツール使用）に非対応です。チャットで Agent をオフにするか HTTP プロバイダを使ってください"
        ));
    }

    // OpenAI Responses API 経路(ツール対応)。function_call / function_call_output で授受。
    if crate::ai_responses::uses_responses_api(params.provider, params.api_variant.as_deref()) {
        return crate::ai_responses::send_with_tools(params, messages, tools).await;
    }

    match params.provider {
        AiProvider::Anthropic => {
            // Collect system content
            let system_content: String = messages
                .iter()
                .filter_map(|m| {
                    if let AgentMessage::System { content } = m {
                        Some(content.as_str())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");

            // Build Anthropic message array
            let mut anthropic_messages: Vec<serde_json::Value> = Vec::new();
            for msg in messages {
                match msg {
                    AgentMessage::User { content } => {
                        anthropic_messages
                            .push(serde_json::json!({ "role": "user", "content": content }));
                    }
                    AgentMessage::Assistant {
                        content,
                        tool_uses,
                        thinking_blocks,
                    } => {
                        let has_extra = !tool_uses.is_empty() || !thinking_blocks.is_empty();
                        if !has_extra {
                            anthropic_messages.push(
                                serde_json::json!({ "role": "assistant", "content": content }),
                            );
                        } else {
                            let mut content_blocks: Vec<serde_json::Value> = Vec::new();
                            // thinking ブロックを先に追加（API 要件: signature 付き）
                            for tb in thinking_blocks {
                                content_blocks.push(serde_json::json!({
                                    "type": "thinking",
                                    "thinking": tb.thinking,
                                    "signature": tb.signature
                                }));
                            }
                            if !content.is_empty() {
                                content_blocks
                                    .push(serde_json::json!({ "type": "text", "text": content }));
                            }
                            for tu in tool_uses {
                                content_blocks.push(serde_json::json!({
                                    "type": "tool_use",
                                    "id": tu.id,
                                    "name": tu.name,
                                    "input": tu.input
                                }));
                            }
                            anthropic_messages.push(serde_json::json!({
                                "role": "assistant",
                                "content": content_blocks
                            }));
                        }
                    }
                    AgentMessage::ToolResult {
                        tool_use_id,
                        content,
                        is_error,
                    } => {
                        anthropic_messages.push(serde_json::json!({
                            "role": "user",
                            "content": [{
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": content,
                                "is_error": is_error
                            }]
                        }));
                    }
                    AgentMessage::System { .. } => {}
                }
            }

            // Build Anthropic tool definitions (deterministic name order for prefix cache)
            let mut sorted_tools: Vec<_> = tools.iter().collect();
            sorted_tools.sort_by(|a, b| a.name.cmp(&b.name));
            let mut anthropic_tools: Vec<serde_json::Value> = sorted_tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema
                    })
                })
                .collect();

            // RAG: native web_search サーバツールを追加 (max_uses でキャップ)。
            // Anthropic がサーバ側で検索→引用付き最終回答を返すため stop_reason は
            // end_turn。クライアント executeTool は介在しない。Phase 2: ドメイン制御
            // (allowed/blocked) はツール定義に直接載る。
            if let Some(ws) = params.web_search.as_ref() {
                if ws.enabled {
                    anthropic_tools.push(build_anthropic_web_search_tool(ws));
                }
            }

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": anthropic_messages,
                "tools": anthropic_tools
            });
            if !system_content.is_empty() || params.system_cache_segments.is_some() {
                body["system"] = build_system_payload(
                    params.provider,
                    params.model,
                    &system_content,
                    params.system_cache_segments.as_deref(),
                    params.system_volatile_tail.as_deref(),
                );
            }
            // thinking / effort パラメータを追加
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_send(anthropic_request(&client, params, &body)).await?;
            let result: serde_json::Value = resp.json().await?;
            parse_anthropic_response(&result)
        }
        _ => {
            // OpenAI-compatible format (OpenAI, OpenRouter, Ollama)。
            // OpenRouter + Claude では system に cache_control を載せて prompt cache を効かせる
            // (チャット経路と同じ手法)。最初の system 1 つにのみ適用 (4 breakpoint 超過=400 を防ぐ)。
            let is_hermes = matches!(params.resolved_tool_protocol, ResolvedToolProtocol::Hermes);

            let openai_messages: Vec<serde_json::Value> = if is_hermes {
                // Hermes: tools[] を送らず (tool 非対応エンドポイントで 404 になるため)、
                // <tools> system XML + <tool_call>/<tool_response> テキストで授受する。
                build_hermes_openai_messages(messages, tools)
            } else {
                let system_cache_blocks = if supports_prompt_cache(params.provider, params.model) {
                    params
                        .system_cache_segments
                        .as_deref()
                        .and_then(openai_system_cache_blocks)
                        .map(|mut blocks| {
                            // 揮発層は cache_control 無しで後置 (チャット経路と同じ理由)。
                            if let Some(tail) = params
                                .system_volatile_tail
                                .as_deref()
                                .filter(|t| !t.is_empty())
                            {
                                blocks.push(serde_json::json!({ "type": "text", "text": tail }));
                            }
                            blocks
                        })
                } else {
                    None
                };
                let mut system_cache_applied = false;
                let mut v: Vec<serde_json::Value> = Vec::new();
                for msg in messages {
                    match msg {
                        AgentMessage::User { content } => {
                            v.push(serde_json::json!({ "role": "user", "content": content }));
                        }
                        AgentMessage::System { content } => {
                            let blocks = if system_cache_applied {
                                None
                            } else {
                                system_cache_blocks.as_ref()
                            };
                            if let Some(blocks) = blocks {
                                system_cache_applied = true;
                                v.push(serde_json::json!({ "role": "system", "content": blocks }));
                            } else {
                                v.push(serde_json::json!({ "role": "system", "content": content }));
                            }
                        }
                        AgentMessage::Assistant {
                            content, tool_uses, ..
                        } => {
                            if tool_uses.is_empty() {
                                v.push(serde_json::json!({
                                    "role": "assistant",
                                    "content": content
                                }));
                            } else {
                                let tool_calls: Vec<serde_json::Value> = tool_uses
                                    .iter()
                                    .map(|tu| {
                                        serde_json::json!({
                                            "id": tu.id,
                                            "type": "function",
                                            "function": {
                                                "name": tu.name,
                                                "arguments": tu.input.to_string()
                                            }
                                        })
                                    })
                                    .collect();
                                let content_val = if content.is_empty() {
                                    serde_json::Value::Null
                                } else {
                                    serde_json::Value::String(content.clone())
                                };
                                v.push(serde_json::json!({
                                    "role": "assistant",
                                    "content": content_val,
                                    "tool_calls": tool_calls
                                }));
                            }
                        }
                        AgentMessage::ToolResult {
                            tool_use_id,
                            content,
                            ..
                        } => {
                            v.push(serde_json::json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content
                            }));
                        }
                    }
                }
                v
            };

            let mut body = if is_hermes {
                // Hermes は tools[] を送らない。ツール定義は system の <tools> に注入済み。
                serde_json::json!({
                    "model": params.model,
                    "messages": openai_messages
                })
            } else {
                let openai_tools: Vec<serde_json::Value> = tools
                    .iter()
                    .map(|t| {
                        serde_json::json!({
                            "type": "function",
                            "function": {
                                "name": t.name,
                                "description": t.description,
                                "parameters": t.input_schema
                            }
                        })
                    })
                    .collect();
                serde_json::json!({
                    "model": params.model,
                    "messages": openai_messages,
                    "tools": openai_tools
                })
            };
            insert_chat_completion_token_limit(
                &mut body,
                params.provider,
                openai_max_tokens(params),
            );
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.model,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );
            // Fusion (マルチモデル合議) は tools 経路でも model=="openrouter/fusion" の
            // とき plugins を注入する。OpenRouter は RAG 対応なので Web 検索 / 関連シーン
            // 注入 / エージェントが ON だと effectiveAgentMode 経由でこの送信に入り、
            // ここで注入しないと fusion が無視されて既定モデルに落ちる(send_chat /
            // send_chat_stream と対称に揃える)。
            apply_openrouter_fusion_to_body(
                &mut body,
                params.provider,
                params.model,
                params.fusion,
            );

            // RAG: OpenRouter のみ Web 検索を注入。Agent モードは server tool
            // (モデルが検索要否を判断)、非 Agent は web plugin (一発検索)。引用は
            // url_citation で統一。Phase 2: ドメイン制御 / content cap が指定された
            // ターンのみ engine=exa を強制し制御を載せる (それ以外は auto のまま)。
            // Responses 経路 (ai_responses::send_with_tools) と同一実装を共有する。
            apply_openrouter_web_search_to_body(
                &mut body,
                params.provider,
                params.web_search.as_ref(),
            );

            // 観測性: GRIMODEX_AI_WIRE_LOG=1 のとき request/response 本文を tracing で出す
            // (本文に小説テキストを含むため既定では出さない)。エラー時は body をエラーへ
            // 載せる (OpenRouter の「No endpoints found that support tool use」等を可視化)。
            if ai_wire_log_enabled() {
                tracing::warn!(
                    target: "ai_wire",
                    "→ request (provider={:?} model={} hermes={}): {}",
                    params.provider,
                    params.model,
                    is_hermes,
                    truncate_for_log(&body.to_string(), 12000)
                );
            }
            let req = openai_compat_request(&client, params, &body);
            let resp = send_with_429_retry(req, params.retry_429, 3).await?;
            let status = resp.status();
            let body_text = resp.text().await?;
            if ai_wire_log_enabled() {
                tracing::warn!(
                    target: "ai_wire",
                    "← response (status={}): {}",
                    status,
                    truncate_for_log(&body_text, 12000)
                );
            }
            if !status.is_success() {
                anyhow::bail!(
                    "AI request failed (HTTP {}): {}",
                    status,
                    truncate_for_log(&body_text, 1500)
                );
            }
            let result: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
                anyhow::anyhow!(
                    "AI response JSON parse failed: {e}; body: {}",
                    truncate_for_log(&body_text, 500)
                )
            })?;
            // Hermes パース有効: 本文 <tool_call> のうち declared tool に一致するものを
            // ToolUse 化。ただし mutating ツールは本文チャンネルから除外する
            // (injection-driven write 防御。HERMES_BLOCKED_TOOL_NAMES 参照)。
            // 低信頼プロバイダでは native tool_calls 経路でも同じ mutating ブロックをかける。
            parse_openai_response(
                &result,
                &ParseOpenAIOptions {
                    resolved_protocol: params.resolved_tool_protocol,
                    allowed_tool_names: hermes_allowed_tool_names(tools),
                    block_mutating_on_native: is_low_trust_native_provider(params.provider),
                },
            )
        }
    }
}

// ---------------------------------------------------------------------------
// PostEffect: single-shot structured JSON call with prompt caching
// ---------------------------------------------------------------------------

/// Make a non-streaming call to the AI API for PostEffects.
/// Uses Anthropic content blocks (with `cache_control`) so that the Codex
/// prefix can be cached across chunk calls (Phase 2+).
///
/// For Anthropic provider: POSTs to /messages with prompt-caching beta header.
/// For OpenRouter→Anthropic: uses /chat/completions; OpenRouter passes
/// `cache_control` through to Anthropic when the selected model is Claude.
/// For other providers: sends without cache_control (silent cost inflation,
/// acceptable for Phase 1 since only Anthropic family supports caching).
///
/// Returns the first text block from the response.
/// post_effect の user content ブロック列（Anthropic 形式）。Codex 前置きには
/// cache_control を付け、チャンク呼び出し間でキャッシュを再利用させる。
/// AUDIT POINT: cache_control must sit at the Codex/Scene boundary.
fn post_effect_user_blocks(
    codex_content: Option<&str>,
    scene_content: &str,
) -> Vec<serde_json::Value> {
    let mut user_blocks: Vec<serde_json::Value> = Vec::new();
    if let Some(codex) = codex_content {
        user_blocks.push(serde_json::json!({
            "type": "text",
            "text": format!("[Codex]\n{}", codex),
            "cache_control": { "type": "ephemeral" }
        }));
    }
    user_blocks.push(serde_json::json!({
        "type": "text",
        "text": format!("[Scene]\n{}", scene_content)
    }));
    user_blocks
}

/// OpenAI 互換 /chat/completions に渡す post_effect の user content。
/// cache_control を解釈できるのは OpenRouter（Claude 系モデルへ passthrough）
/// だけで、Ollama や一部のローカル OpenAI 互換サーバはパーツ配列そのものを
/// 400 で拒否する実装がある。そのため OpenRouter 以外はチャット経路と同じ
/// プレーン文字列 content に平坦化する。
pub(crate) fn post_effect_openai_user_content(
    provider: &AiProvider,
    codex_content: Option<&str>,
    scene_content: &str,
) -> serde_json::Value {
    if matches!(provider, AiProvider::OpenRouter) {
        return serde_json::Value::Array(post_effect_user_blocks(codex_content, scene_content));
    }
    let text = match codex_content {
        Some(codex) => format!("[Codex]\n{codex}\n\n[Scene]\n{scene_content}"),
        None => format!("[Scene]\n{scene_content}"),
    };
    serde_json::Value::String(text)
}

/// HTTP エラー時にステータスだけでなくレスポンスボディ（プロバイダの実エラー
/// メッセージ）まで拾って anyhow エラーにする。`error_for_status()` はボディを
/// 捨てるため、Ollama の 400 などが「Bad Request」以上の情報を持てなかった。
async fn error_with_response_body(
    resp: reqwest::Response,
    url: &str,
) -> anyhow::Result<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body_text = resp.text().await.unwrap_or_default();
    let snippet: String = body_text.chars().take(300).collect();
    anyhow::bail!("HTTP {status} ({url}): {snippet}")
}

pub async fn call_post_effect_api(
    settings: &AiSettings,
    api_key: &str,
    system_prompt: &str,
    // Codex JSON text to attach with cache_control (None for intra_scene_consistency).
    codex_content: Option<&str>,
    scene_content: &str,
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let endpoints = settings.endpoints();

    match settings.provider {
        AiProvider::Anthropic => {
            let url = format!("{}/messages", settings.provider.base_url(endpoints));
            let body = serde_json::json!({
                "model": settings.model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [{
                    "role": "user",
                    "content": post_effect_user_blocks(codex_content, scene_content)
                }]
            });
            let resp = client
                .post(url.as_str())
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "prompt-caching-2024-07-31")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?;
            let resp = error_with_response_body(resp, &url).await?;
            let result: serde_json::Value = resp.json().await?;
            extract_first_text_block_anthropic(&result)
        }
        AiProvider::AiNovelist => {
            anyhow::bail!("AiNovelist プロバイダは PostEffects に対応していません")
        }
        _ => {
            // OpenRouter / OpenAI compat: use /chat/completions.
            // OpenRouter passes cache_control to Anthropic when using a Claude model.
            let api_variant = resolve_api_variant(None, settings, &settings.model);
            tracing::info!(
                "AI route: surface=post_effect route={} provider={:?} model={} variant={}",
                if crate::ai_responses::uses_responses_api(
                    &settings.provider,
                    api_variant.as_deref()
                ) {
                    "responses"
                } else {
                    "chat_completions"
                },
                settings.provider,
                settings.model,
                api_variant.as_deref().unwrap_or("-")
            );
            // OpenAI Responses API 経路: /responses で単発 grader 呼び出し。
            if crate::ai_responses::uses_responses_api(&settings.provider, api_variant.as_deref()) {
                return crate::ai_responses::post_effect(
                    settings,
                    api_key,
                    system_prompt,
                    codex_content,
                    scene_content,
                )
                .await;
            }
            let url = format!(
                "{}/chat/completions",
                settings
                    .provider
                    .openai_compat_base_url(endpoints, api_variant.as_deref())
            );
            let user_content =
                post_effect_openai_user_content(&settings.provider, codex_content, scene_content);
            let mut body = serde_json::json!({
                "model": settings.model,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user",   "content": user_content }
                ]
            });
            // OpenAI 直叩き / Sakana(fugu) は reasoning モデルが max_tokens を 400 拒否する
            // ため max_completion_tokens に切替 + 予算を確保する(他の reasoning 予算サイトと整合)。
            // OpenRouter は従量課金のため既知の reasoning モデルのみ 32k に広げる。
            // Ollama / OpenaiCompatible は上限を送らない (None): ローカル・自己管理
            // エンドポイントの reasoning 系モデル (deepseek-r1 / qwen3 / plamo 等) は
            // hidden reasoning が max_tokens に課金され 4096 だと JSON 本文が途中で
            // 切れる一方、32k 等の固定値は小コンテキストのサーバ (vLLM の
            // max-model-len 8192 等) が「prompt + max_tokens > 上限」の 400 で全シーン
            // 拒否する。省略すればサーバ既定 (モデル上限 / 残コンテキストへの自動丸め)
            // に委ねられ、切断も 400 も避けられる。
            let post_effect_limit: Option<u32> =
                if matches!(settings.provider, AiProvider::OpenAI | AiProvider::Sakana)
                    || (matches!(settings.provider, AiProvider::OpenRouter)
                        && is_openrouter_reasoning_model(&settings.model))
                {
                    Some(32_000)
                } else if matches!(
                    settings.provider,
                    AiProvider::Ollama | AiProvider::OpenaiCompatible
                ) {
                    None
                } else {
                    Some(4096)
                };
            if let Some(limit) = post_effect_limit {
                insert_chat_completion_token_limit(&mut body, &settings.provider, limit);
            }
            apply_openrouter_provider_pin(
                &mut body,
                &settings.provider,
                settings.openrouter_provider_pin.as_deref(),
            );
            let mut req = client
                .post(url.as_str())
                .header("content-type", "application/json");
            let needs_auth = match settings.provider {
                AiProvider::Ollama => false,
                AiProvider::OpenaiCompatible => !api_key.is_empty(),
                _ => true,
            };
            if needs_auth {
                req = req.header("Authorization", format!("Bearer {api_key}"));
            }
            if matches!(settings.provider, AiProvider::OpenRouter) {
                req = req
                    .header("HTTP-Referer", "https://github.com/kazormia296/Grimodex")
                    .header("X-Title", "Grimodex");
            }
            let resp = req.json(&body).send().await?;
            let resp = error_with_response_body(resp, &url).await?;
            let result: serde_json::Value = resp.json().await?;
            // トークン上限による途中切断は後段の JSON パース失敗として現れ、
            // 原因が分かりにくい。診断の足がかりとして finish_reason を残す。
            if result["choices"][0]["finish_reason"].as_str() == Some("length") {
                tracing::warn!(
                    model = %settings.model,
                    limit = ?post_effect_limit,
                    "post_effect: 応答がトークン上限で打ち切られた (finish_reason=length) — JSON パース失敗の可能性が高い"
                );
            }
            extract_first_text_block_openai(&result)
        }
    }
}

fn extract_first_text_block_anthropic(result: &serde_json::Value) -> anyhow::Result<String> {
    result["content"]
        .as_array()
        .and_then(|arr| arr.iter().find(|b| b["type"] == "text"))
        .and_then(|b| b["text"].as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let err = result["error"]["message"]
                .as_str()
                .unwrap_or("no text block in response");
            anyhow::anyhow!("Anthropic API error: {err}")
        })
}

fn extract_first_text_block_openai(result: &serde_json::Value) -> anyhow::Result<String> {
    result["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| {
            let err = result["error"]["message"]
                .as_str()
                .unwrap_or("no content in response");
            anyhow::anyhow!("API error: {err}")
        })
}

/// OpenAI 互換チャンクの `choices[0].delta.content` は文字列のほか、
/// 一部プロバイダ・エンドポイントで `{type,text}[]` 形式になる。
fn openai_stream_delta_content(delta: &serde_json::Value) -> Option<String> {
    match delta.get("content") {
        None | Some(serde_json::Value::Null) => None,
        Some(serde_json::Value::String(s)) => {
            if s.is_empty() {
                None
            } else {
                Some(s.clone())
            }
        }
        Some(serde_json::Value::Array(parts)) => {
            let mut out = String::new();
            for p in parts {
                let Some(obj) = p.as_object() else {
                    continue;
                };
                if obj.get("type").and_then(|t| t.as_str()) != Some("text") {
                    continue;
                }
                if let Some(t) = obj.get("text").and_then(|v| v.as_str()) {
                    out.push_str(t);
                }
            }
            if out.is_empty() {
                None
            } else {
                Some(out)
            }
        }
        Some(_other) => None,
    }
}

// ---------------------------------------------------------------------------
// G1: Streaming chat
// ---------------------------------------------------------------------------

/// SSE 蓄積バッファの上限 (security audit RUST-DOS-02)。frame separator を含まない
/// ストリーム (バグ持ち / 悪意ある custom endpoint) で buf が無制限に増大し自プロセスの
/// メモリを枯渇させるのを防ぐ defense-in-depth。正当な SSE フレーム最大を十分上回る値で、
/// endpoint はユーザ設定 (semi-trusted) のため安全側に倒す。
pub(crate) const MAX_SSE_BUFFER_BYTES: usize = 8 * 1024 * 1024; // 8 MiB

/// SSE イベント境界。仕様は「空行」だが、`\r\n\r\n` と `\n\n` の両方を扱う。
/// Windows 経由や一部プロキシでは CRLF のみになり `"\n\n"` 検出で永遠にバッファが進まないことがある。
#[inline]
pub(crate) fn find_sse_frame_separator(buf: &str) -> Option<(usize, usize)> {
    if let Some(pos) = buf.find("\r\n\r\n") {
        return Some((pos, 4));
    }
    if let Some(pos) = buf.find("\n\n") {
        return Some((pos, 2));
    }
    None
}

/// ストリーミングで usage (トークン数 / OpenRouter は cost) を最終チャンクに
/// 含めるようプロバイダにオプトインする (N4)。多くのプロバイダはストリーム時に
/// デフォルトで usage を返さないため、これを設定しないと FE 側でトークンが常に
/// null になる (= 既定構成の OpenRouter streaming でメインチャットの台帳が
/// null トークン行になる)。読み取り側は防御的なので、未対応でも害は無い。
///
/// - OpenRouter: `usage: { include: true }` (ネイティブ。cost も返る)
/// - OpenAI / OpenAI 互換: `stream_options: { include_usage: true }` (標準)
/// - Ollama: 既定で usage を返すため何もしない (未知フィールドでの 400 を回避)
/// - その他 (AI のべりすと v1 等): 対象外
///
/// NOTE: live verification は未実施 (実 OpenRouter/OpenAI への streaming 往復が
/// 必要で unit test 不可)。E2E 検証は別途。
fn apply_stream_usage_optin(body: &mut serde_json::Value, provider: &AiProvider) {
    match provider {
        AiProvider::OpenRouter => {
            body["usage"] = serde_json::json!({ "include": true });
        }
        AiProvider::OpenAI | AiProvider::OpenaiCompatible | AiProvider::Sakana => {
            body["stream_options"] = serde_json::json!({ "include_usage": true });
        }
        _ => {}
    }
}

pub async fn send_chat_stream(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
    abort_flag: Arc<std::sync::atomic::AtomicBool>,
    app_handle: tauri::AppHandle,
    event_prefix: &str,
) -> anyhow::Result<()> {
    use tauri::Emitter;

    let chunk_event = format!("{}:stream-chunk", event_prefix);
    let done_event = format!("{}:stream-done", event_prefix);

    let client = reqwest::Client::new();
    log_ai_route("send_chat_stream", params, 0);

    // AI のべりすと legacy: ストリーミング非対応なので非ストリーム版を呼んで結果を一括 emit
    if matches!(params.provider, AiProvider::AiNovelist) && !is_ainoverist_v1(params) {
        if abort_flag.load(Ordering::Relaxed) {
            let _ = app_handle.emit(
                &done_event,
                serde_json::json!({
                    "stop_reason": "stopped",
                    "input_tokens": null,
                    "output_tokens": null,
                }),
            );
            return Ok(());
        }
        let response = send_chat_ainoverist(&client, params, messages).await?;
        for block in &response.blocks {
            if let ResponseBlock::Text { content } = block {
                if !content.is_empty() {
                    let _ = app_handle.emit(
                        &chunk_event,
                        serde_json::json!({
                            "delta": content,
                            "block_type": "text",
                        }),
                    );
                }
            }
        }
        let _ = app_handle.emit(
            &done_event,
            serde_json::json!({
                "stop_reason": response.stop_reason,
                "input_tokens": response.input_tokens,
                "output_tokens": response.output_tokens,
            }),
        );
        return Ok(());
    }

    // OpenAI Responses API ストリーミング経路。型付き SSE を共通 chunk/done に正規化。
    if crate::ai_responses::uses_responses_api(params.provider, params.api_variant.as_deref()) {
        return crate::ai_responses::send_stream(
            params,
            messages,
            abort_flag.clone(),
            app_handle.clone(),
            event_prefix,
        )
        .await;
    }

    match params.provider {
        AiProvider::Cli => {
            anyhow::bail!(
                "CLI は send_cli_chat_stream を使う必要があります (HTTP ストリームは未対応)"
            );
        }
        AiProvider::Anthropic => {
            let (system_content, chat_messages) = split_system_messages(messages);

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
                "stream": true,
            });
            let system_payload = build_system_payload(
                params.provider,
                params.model,
                &system_content,
                params.system_cache_segments.as_deref(),
                params.system_volatile_tail.as_deref(),
            );
            if !system_content.is_empty() || params.system_cache_segments.is_some() {
                body["system"] = system_payload;
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_send(anthropic_request(&client, params, &body)).await?;

            let mut stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut current_block_type = "text".to_string();
            let mut stop_reason = "end_turn".to_string();
            let mut input_tokens: Option<u64> = None;
            let mut output_tokens: Option<u64> = None;
            // N4: prompt cache 計測。Anthropic 直は message_start の usage に載る。
            let mut cache_read_tokens: Option<u64> = None;
            let mut cache_write_tokens: Option<u64> = None;

            while let Some(chunk) = stream.next().await {
                if abort_flag.load(Ordering::Relaxed) {
                    stop_reason = "stopped".to_string();
                    break;
                }
                let bytes = chunk.map_err(|e| anyhow::anyhow!("stream error: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));
                // separator を含まないまま buf が上限を超えたら中断 (RUST-DOS-02)。
                // separator があれば下の while で drain されるため、ここに到達する
                // のは「complete frame が一つも無いのに肥大化した」病的ケースのみ。
                if buf.len() > MAX_SSE_BUFFER_BYTES && find_sse_frame_separator(&buf).is_none() {
                    return Err(anyhow::anyhow!(
                        "SSE buffer exceeded {MAX_SSE_BUFFER_BYTES} bytes without a frame separator"
                    ));
                }

                // Process complete SSE messages separated by \n\n or \r\n\r\n
                while let Some((pos, sep_len)) = find_sse_frame_separator(&buf) {
                    let chunk_str = buf[..pos].to_string();
                    buf.drain(..pos + sep_len);

                    for line in chunk_str.lines() {
                        if let Some(rest) = line.strip_prefix("data: ") {
                            let data = rest.trim_end_matches('\r');
                            if data == "[DONE]" {
                                break;
                            }
                            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                                continue;
                            };

                            match json["type"].as_str() {
                                Some("content_block_start") => {
                                    let bt =
                                        json["content_block"]["type"].as_str().unwrap_or("text");
                                    current_block_type = if bt == "thinking" {
                                        "thinking".to_string()
                                    } else {
                                        "text".to_string()
                                    };
                                }
                                Some("content_block_delta") => {
                                    let delta_type = json["delta"]["type"].as_str().unwrap_or("");
                                    let delta_text = if delta_type == "thinking_delta" {
                                        json["delta"]["thinking"].as_str().unwrap_or("")
                                    } else if delta_type == "text_delta" {
                                        json["delta"]["text"].as_str().unwrap_or("")
                                    } else {
                                        ""
                                    };
                                    if !delta_text.is_empty() {
                                        let _ = app_handle.emit(
                                            &chunk_event,
                                            serde_json::json!({
                                                "delta": delta_text,
                                                "block_type": current_block_type
                                            }),
                                        );
                                    }
                                }
                                Some("message_delta") => {
                                    if let Some(reason) = json["delta"]["stop_reason"].as_str() {
                                        stop_reason = reason.to_string();
                                    }
                                    if let Some(out) = json["usage"]["output_tokens"].as_u64() {
                                        output_tokens = Some(out);
                                    }
                                }
                                Some("message_start") => {
                                    let usage = &json["message"]["usage"];
                                    if let Some(inp) = usage["input_tokens"].as_u64() {
                                        input_tokens = Some(inp);
                                    }
                                    let (cr, cw) = extract_cache_tokens(usage, params.provider);
                                    if cr.is_some() {
                                        cache_read_tokens = cr;
                                    }
                                    if cw.is_some() {
                                        cache_write_tokens = cw;
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }

            let _ = app_handle.emit(
                &done_event,
                serde_json::json!({
                    "stop_reason": stop_reason,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cache_read_tokens": cache_read_tokens,
                    "cache_write_tokens": cache_write_tokens,
                }),
            );
            Ok(())
        }
        _ => {
            // OpenAI-compatible format (OpenAI, OpenRouter, Ollama)。
            // OpenRouter + Claude では system に cache_control を載せて prompt cache を効かせる。
            let chat_messages = build_openai_chat_messages(
                messages,
                params.provider,
                params.model,
                params.system_cache_segments.as_deref(),
                params.system_volatile_tail.as_deref(),
            );

            let mut body = serde_json::json!({
                "model": params.model,
                "messages": chat_messages,
                "stream": true,
            });
            insert_chat_completion_token_limit(
                &mut body,
                params.provider,
                openai_max_tokens(params),
            );
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.model,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );
            apply_openrouter_fusion_to_body(
                &mut body,
                params.provider,
                params.model,
                params.fusion,
            );

            // N4: ストリーミングでも usage/cost を最終チャンクで受け取る。
            apply_stream_usage_optin(&mut body, params.provider);

            // 観測性: GRIMODEX_AI_WIRE_LOG=1 のとき送信本文を出す。非エージェントの
            // ライブチャット(fusion 含む)はこの経路を通るため、plugins[fusion] が実際に
            // 載っているかをここで確認できる(既定では小説本文を含むので出さない)。
            if ai_wire_log_enabled() {
                tracing::warn!(
                    target: "ai_wire",
                    "→ stream request (provider={:?} model={}): {}",
                    params.provider,
                    params.model,
                    truncate_for_log(&body.to_string(), 12000)
                );
            }

            let req = openai_compat_request(&client, params, &body);
            let resp = send_with_429_retry(req, params.retry_429, 3).await?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body_text = resp.text().await.unwrap_or_default();
                return Err(anyhow::anyhow!("HTTP {}: {}", status, body_text));
            }

            let mut stream = resp.bytes_stream();
            let mut buf = String::new();
            let mut stop_reason = "end_turn".to_string();
            let mut input_tokens: Option<u64> = None;
            let mut output_tokens: Option<u64> = None;
            // OpenRouter は usage.cost を返す (他プロバイダは None → FE が概算)。
            let mut cost: Option<f64> = None;
            // N4: prompt cache 計測。OpenRouter は最終 usage チャンクの
            // prompt_tokens_details に載る (include:true 時のみ届く)。
            let mut cache_read_tokens: Option<u64> = None;
            let mut cache_write_tokens: Option<u64> = None;

            while let Some(chunk) = stream.next().await {
                if abort_flag.load(Ordering::Relaxed) {
                    stop_reason = "stopped".to_string();
                    break;
                }
                let bytes = chunk.map_err(|e| anyhow::anyhow!("stream error: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));
                // separator を含まないまま buf が上限を超えたら中断 (RUST-DOS-02)。
                if buf.len() > MAX_SSE_BUFFER_BYTES && find_sse_frame_separator(&buf).is_none() {
                    return Err(anyhow::anyhow!(
                        "SSE buffer exceeded {MAX_SSE_BUFFER_BYTES} bytes without a frame separator"
                    ));
                }

                while let Some((pos, sep_len)) = find_sse_frame_separator(&buf) {
                    let chunk_str = buf[..pos].to_string();
                    buf.drain(..pos + sep_len);

                    for line in chunk_str.lines() {
                        if let Some(rest) = line.strip_prefix("data: ") {
                            let data = rest.trim_end_matches('\r');
                            if data.trim() == "[DONE]" {
                                break;
                            }
                            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                                continue;
                            };

                            // Accumulate usage
                            if let Some(inp) = json["usage"]["prompt_tokens"].as_u64() {
                                input_tokens = Some(inp);
                            }
                            if let Some(out) = json["usage"]["completion_tokens"].as_u64() {
                                output_tokens = Some(out);
                            }
                            // N4: prompt cache 読込/書込トークン (provider 別の形を吸収)。
                            let (cr, cw) = extract_cache_tokens(&json["usage"], params.provider);
                            if cr.is_some() {
                                cache_read_tokens = cr;
                            }
                            if cw.is_some() {
                                cache_write_tokens = cw;
                            }
                            // OpenRouter: usage.cost (USD)。include:true 時のみ届く。
                            if let Some(c) = json["usage"]["cost"].as_f64() {
                                cost = Some(c);
                            }

                            // finish_reason
                            if let Some(reason) = json["choices"][0]["finish_reason"].as_str() {
                                if reason != "null" {
                                    stop_reason = if reason == "stop" {
                                        "end_turn".to_string()
                                    } else {
                                        reason.to_string()
                                    };
                                }
                            }

                            let delta = &json["choices"][0]["delta"];

                            // Ollama: thinking フィールド
                            if let Some(thinking_text) = delta["thinking"].as_str() {
                                if !thinking_text.is_empty() {
                                    let _ = app_handle.emit(
                                        &chunk_event,
                                        serde_json::json!({
                                            "delta": thinking_text,
                                            "block_type": "thinking"
                                        }),
                                    );
                                }
                            }

                            // OpenRouter は delta.reasoning が canonical、reasoning_content は alias。
                            let reasoning_delta = delta["reasoning"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .or_else(|| {
                                    delta["reasoning_content"]
                                        .as_str()
                                        .filter(|s| !s.is_empty())
                                });
                            if let Some(reasoning) = reasoning_delta {
                                let _ = app_handle.emit(
                                    &chunk_event,
                                    serde_json::json!({
                                        "delta": reasoning,
                                        "block_type": "thinking"
                                    }),
                                );
                            }

                            if let Some(content) = openai_stream_delta_content(delta) {
                                let _ = app_handle.emit(
                                    &chunk_event,
                                    serde_json::json!({
                                        "delta": content,
                                        "block_type": "text"
                                    }),
                                );
                            }
                        }
                    }
                }
            }

            let _ = app_handle.emit(
                &done_event,
                serde_json::json!({
                    "stop_reason": stop_reason,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
                    "cost": cost,
                    "cache_read_tokens": cache_read_tokens,
                    "cache_write_tokens": cache_write_tokens,
                }),
            );
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    // ── 複数 OpenAI 互換エンドポイント (Approach B) ──────────────────────────

    #[test]
    fn normalize_migrates_legacy_single_endpoint() {
        let mut s = AiSettings {
            openai_compatible: OpenaiCompatibleSettings {
                base_url: "http://localhost:8080/v1".to_string(),
                custom_max_context: Some(32_000),
                custom_max_output: Some(4096),
                enable_structured_tasks: Some(true),
            },
            ..Default::default()
        };
        s.normalize_openai_compatible();
        assert_eq!(s.openai_compatible_endpoints.len(), 1);
        let ep = &s.openai_compatible_endpoints[0];
        assert_eq!(ep.id, LEGACY_OPENAI_COMPAT_ENDPOINT_ID);
        assert_eq!(ep.base_url, "http://localhost:8080/v1");
        assert_eq!(ep.custom_max_context, Some(32_000));
        assert_eq!(ep.enable_structured_tasks, Some(true));
        assert_eq!(
            s.active_openai_compatible_endpoint_id.as_deref(),
            Some(LEGACY_OPENAI_COMPAT_ENDPOINT_ID)
        );
    }

    #[test]
    fn normalize_is_idempotent() {
        let mut s = AiSettings {
            openai_compatible: OpenaiCompatibleSettings {
                base_url: "http://host/v1".to_string(),
                ..Default::default()
            },
            ..Default::default()
        };
        s.normalize_openai_compatible();
        s.normalize_openai_compatible();
        assert_eq!(s.openai_compatible_endpoints.len(), 1);
    }

    #[test]
    fn normalize_empty_legacy_yields_no_endpoints() {
        let mut s = AiSettings::default();
        s.normalize_openai_compatible();
        assert!(s.openai_compatible_endpoints.is_empty());
        assert_eq!(s.active_openai_compatible_endpoint_id, None);
    }

    #[test]
    fn normalize_repairs_invalid_active_id_to_first() {
        let mut s = AiSettings {
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: "a".into(),
                    base_url: "http://a/v1".into(),
                    ..Default::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "b".into(),
                    base_url: "http://b/v1".into(),
                    ..Default::default()
                },
            ],
            active_openai_compatible_endpoint_id: Some("missing".into()),
            ..Default::default()
        };
        s.normalize_openai_compatible();
        assert_eq!(s.active_openai_compatible_endpoint_id.as_deref(), Some("a"));
    }

    #[test]
    fn active_endpoint_resolves_by_id_then_first() {
        let s = AiSettings {
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: "a".into(),
                    base_url: "http://a/v1".into(),
                    ..Default::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "b".into(),
                    base_url: "http://b/v1".into(),
                    ..Default::default()
                },
            ],
            active_openai_compatible_endpoint_id: Some("b".into()),
            ..Default::default()
        };
        assert_eq!(s.active_openai_compatible_endpoint().unwrap().id, "b");
        // 不正 id は先頭にフォールバック。
        let s2 = AiSettings {
            active_openai_compatible_endpoint_id: Some("zzz".into()),
            ..s.clone()
        };
        assert_eq!(s2.active_openai_compatible_endpoint().unwrap().id, "a");
    }

    #[test]
    fn endpoints_uses_active_endpoint_base_url() {
        let s = AiSettings {
            openai_compatible_endpoints: vec![
                OpenaiCompatibleEndpoint {
                    id: "a".into(),
                    base_url: "http://a/v1".into(),
                    ..Default::default()
                },
                OpenaiCompatibleEndpoint {
                    id: "b".into(),
                    base_url: "http://b/v1".into(),
                    ..Default::default()
                },
            ],
            active_openai_compatible_endpoint_id: Some("b".into()),
            ..Default::default()
        };
        assert_eq!(s.endpoints().openai_compat_custom, "http://b/v1");
    }

    #[test]
    fn endpoints_falls_back_to_legacy_base_url_when_unnormalized() {
        // normalize 前でも legacy base_url が拾われる（defense in depth）。
        let s = AiSettings {
            openai_compatible: OpenaiCompatibleSettings {
                base_url: "http://legacy/v1".into(),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(s.endpoints().openai_compat_custom, "http://legacy/v1");
    }

    #[test]
    fn has_openai_compatible_endpoint_detects_known_ids() {
        let s = AiSettings {
            openai_compatible_endpoints: vec![OpenaiCompatibleEndpoint {
                id: "a".into(),
                base_url: "http://a/v1".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(s.has_openai_compatible_endpoint("a"));
        assert!(!s.has_openai_compatible_endpoint("zzz"));
        assert!(!s.has_openai_compatible_endpoint(""));
    }

    #[test]
    fn keyring_user_uses_endpoint_id_only_for_compatible() {
        assert_eq!(
            keyring_user(&AiProvider::OpenaiCompatible, Some("ep1")),
            "ep1"
        );
        assert_eq!(
            keyring_user(&AiProvider::OpenaiCompatible, None),
            KEYRING_USER
        );
        assert_eq!(
            keyring_user(&AiProvider::OpenaiCompatible, Some("")),
            KEYRING_USER
        );
        // 互換以外は endpoint_id を無視して単一ユーザー。
        assert_eq!(keyring_user(&AiProvider::OpenAI, Some("ep1")), KEYRING_USER);
    }

    #[test]
    fn keyring_user_candidates_purge_legacy_for_default_endpoint() {
        // 移行既定エンドポイント ("default") は自分の user に加えて旧 user も対象。
        // get はこの順で最初に見つかったものを返し、delete は全員を消すため、
        // 「default で削除しても legacy が残り has_api_key が true を返し続ける」
        // 非対称バグが構造的に起こらないことを保証する。
        assert_eq!(
            keyring_user_candidates(
                &AiProvider::OpenaiCompatible,
                Some(LEGACY_OPENAI_COMPAT_ENDPOINT_ID),
            ),
            vec![
                LEGACY_OPENAI_COMPAT_ENDPOINT_ID.to_string(),
                KEYRING_USER.to_string(),
            ],
        );
        // 新規追加エンドポイント (任意 id) は legacy フォールバック無し（自分のみ）。
        assert_eq!(
            keyring_user_candidates(&AiProvider::OpenaiCompatible, Some("ep1")),
            vec!["ep1".to_string()],
        );
        // endpoint_id 無し / 互換以外は単一の旧 user のみ。
        assert_eq!(
            keyring_user_candidates(&AiProvider::OpenaiCompatible, None),
            vec![KEYRING_USER.to_string()],
        );
        assert_eq!(
            keyring_user_candidates(&AiProvider::OpenAI, Some("ep1")),
            vec![KEYRING_USER.to_string()],
        );
    }

    #[test]
    fn resolve_api_variant_uses_endpoint_default_for_compatible() {
        let s = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            openai_compatible_endpoints: vec![OpenaiCompatibleEndpoint {
                id: "a".into(),
                base_url: "http://a/v1".into(),
                api_variant: Some("responses".into()),
                ..Default::default()
            }],
            active_openai_compatible_endpoint_id: Some("a".into()),
            ..Default::default()
        };
        // 明示なし・グローバルなし → エンドポイント既定 "responses"。
        assert_eq!(
            resolve_api_variant(None, &s, "gpt-4o").as_deref(),
            Some("responses")
        );
        // 明示指定はエンドポイント既定より優先。
        assert_eq!(
            resolve_api_variant(Some("v1"), &s, "gpt-4o").as_deref(),
            Some("v1")
        );
    }

    #[test]
    fn resolve_api_variant_compatible_ignores_global_responses_toggle() {
        // 回帰: 他プロバイダ(OpenAI 等)で ON にしたグローバル Responses トグル
        // (model_api_variant="responses") が残留しても、openai-compatible では
        // エンドポイント単位 apiVariant が正本。endpoint 未指定(auto)なら経路は
        // None=/chat/completions に解決し、/responses 非対応の互換サーバ(PlaMo /
        // LM Studio 等)へ漏らさない。
        let s = AiSettings {
            provider: AiProvider::OpenaiCompatible,
            // グローバル Responses トグルの残留。
            model_api_variant: Some("responses".into()),
            openai_compatible_endpoints: vec![OpenaiCompatibleEndpoint {
                id: "a".into(),
                base_url: "https://api.platform.preferredai.jp/v1".into(),
                // endpoint は auto(未指定)。
                api_variant: None,
                ..Default::default()
            }],
            active_openai_compatible_endpoint_id: Some("a".into()),
            ..Default::default()
        };
        // auto endpoint + グローバル responses 残留 → /chat/completions (None)。
        assert_eq!(resolve_api_variant(None, &s, "plamo-3.0-prime"), None);

        // endpoint が明示的に "responses" を選んだ場合のみ responses に乗る。
        let mut s_resp = s.clone();
        s_resp.openai_compatible_endpoints[0].api_variant = Some("responses".into());
        assert_eq!(
            resolve_api_variant(None, &s_resp, "plamo-3.0-prime").as_deref(),
            Some("responses")
        );

        // endpoint "v1" はグローバル responses 残留より優先され /chat/completions。
        let mut s_v1 = s.clone();
        s_v1.openai_compatible_endpoints[0].api_variant = Some("v1".into());
        assert_eq!(
            resolve_api_variant(None, &s_v1, "plamo-3.0-prime").as_deref(),
            Some("v1")
        );
    }

    #[test]
    fn read_ai_settings_normalizes_legacy_on_load() {
        let path = temp_path("normalize_on_load");
        let legacy = r#"{"provider":"openai-compatible","model":"m","ollamaEndpoint":"http://localhost:11434","thinkingEnabled":true,"openaiCompatible":{"baseUrl":"http://legacy/v1"}}"#;
        fs::write(&path, legacy).unwrap();
        let loaded = read_ai_settings(&path);
        assert_eq!(loaded.openai_compatible_endpoints.len(), 1);
        assert_eq!(
            loaded.active_openai_compatible_endpoint_id.as_deref(),
            Some(LEGACY_OPENAI_COMPAT_ENDPOINT_ID)
        );
        assert_eq!(loaded.endpoints().openai_compat_custom, "http://legacy/v1");
        cleanup(&path);
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex_ai_test_{name}"))
    }

    fn cleanup(path: &Path) {
        fs::remove_file(path).ok();
        if let Some(parent) = path.parent() {
            fs::remove_dir(parent).ok();
        }
    }

    #[test]
    fn openai_stream_delta_content_parses_text_parts_array() {
        let delta = serde_json::json!({
            "role": "assistant",
            "content": [{ "type": "text", "text": "hello" }]
        });
        assert_eq!(
            openai_stream_delta_content(&delta).as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn openai_stream_delta_content_string_still_works() {
        let delta = serde_json::json!({ "content": "plain" });
        assert_eq!(
            openai_stream_delta_content(&delta).as_deref(),
            Some("plain")
        );
    }

    #[test]
    fn extract_cache_tokens_openrouter_reads_prompt_tokens_details() {
        // OpenRouter / OpenAI 互換: prompt_tokens_details.cached_tokens / cache_write_tokens。
        let usage = serde_json::json!({
            "prompt_tokens": 1500,
            "completion_tokens": 200,
            "prompt_tokens_details": { "cached_tokens": 1200, "cache_write_tokens": 300 }
        });
        let (read, write) = extract_cache_tokens(&usage, &AiProvider::OpenRouter);
        assert_eq!(read, Some(1200));
        assert_eq!(write, Some(300));
    }

    #[test]
    fn extract_cache_tokens_anthropic_reads_input_token_fields() {
        // Anthropic 直: cache_read_input_tokens / cache_creation_input_tokens。
        let usage = serde_json::json!({
            "input_tokens": 50,
            "output_tokens": 200,
            "cache_read_input_tokens": 1200,
            "cache_creation_input_tokens": 300
        });
        let (read, write) = extract_cache_tokens(&usage, &AiProvider::Anthropic);
        assert_eq!(read, Some(1200));
        assert_eq!(write, Some(300));
    }

    #[test]
    fn extract_cache_tokens_does_not_cross_read_provider_shapes() {
        // プロバイダ会計モデルの取り違え防止: Anthropic 形の usage を OpenRouter
        // として読むと (prompt_tokens_details 不在で) None、その逆も None。
        let anthropic_shape = serde_json::json!({
            "cache_read_input_tokens": 1200,
            "cache_creation_input_tokens": 300
        });
        assert_eq!(
            extract_cache_tokens(&anthropic_shape, &AiProvider::OpenRouter),
            (None, None)
        );
        let openai_shape = serde_json::json!({
            "prompt_tokens_details": { "cached_tokens": 1200, "cache_write_tokens": 300 }
        });
        assert_eq!(
            extract_cache_tokens(&openai_shape, &AiProvider::Anthropic),
            (None, None)
        );
    }

    #[test]
    fn extract_cache_tokens_absent_yields_none() {
        // キャッシュ未使用 (フィールド欠落) は None で素通し。
        let usage = serde_json::json!({ "prompt_tokens": 100, "completion_tokens": 50 });
        assert_eq!(
            extract_cache_tokens(&usage, &AiProvider::OpenRouter),
            (None, None)
        );
        let usage_anthropic = serde_json::json!({ "input_tokens": 100, "output_tokens": 50 });
        assert_eq!(
            extract_cache_tokens(&usage_anthropic, &AiProvider::Anthropic),
            (None, None)
        );
    }

    #[test]
    fn build_openai_chat_messages_adds_cache_control_to_system_for_openrouter_claude() {
        // OpenRouter + Claude + segments → system content を cache_control 付き block 配列に。
        let msgs = [("system", "FULL_SYSTEM"), ("user", "hi")];
        let segments = vec!["L1".to_string(), "L2".to_string()];
        let out = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "anthropic/claude-4.6-sonnet",
            Some(&segments),
            Some("TAIL"),
        );
        assert!(
            out[0]["content"].is_array(),
            "system content should be blocks"
        );
        assert_eq!(out[0]["content"][0]["text"], "L1");
        assert_eq!(out[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out[0]["content"][1]["text"], "L2");
        assert_eq!(out[0]["content"][1]["cache_control"]["type"], "ephemeral");
        // 揮発層 (L5 等) は cache_control 無しの末尾 block として届く。
        assert_eq!(out[0]["content"][2]["text"], "TAIL");
        assert!(out[0]["content"][2].get("cache_control").is_none());
        // user は plain string のまま。
        assert_eq!(out[1]["content"], "hi");
        assert_eq!(out[1]["role"], "user");
    }

    #[test]
    fn build_system_payload_appends_volatile_tail_without_cache_control() {
        // Anthropic + segments + tail → blocks 末尾に cache_control 無し block。
        let segments = vec!["SEG1".to_string(), "SEG2".to_string()];
        let out = build_system_payload(
            &AiProvider::Anthropic,
            "claude-sonnet-4-6",
            "FULL",
            Some(&segments),
            Some("L5_SUMMARY"),
        );
        let blocks = out.as_array().expect("blocks array");
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[1]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[2]["text"], "L5_SUMMARY");
        assert!(blocks[2].get("cache_control").is_none());
        // tail が空なら従来どおり segments のみ。
        let out2 = build_system_payload(
            &AiProvider::Anthropic,
            "claude-sonnet-4-6",
            "FULL",
            Some(&segments),
            Some(""),
        );
        assert_eq!(out2.as_array().unwrap().len(), 2);
        // segments 無し → fallback (prompt 全文が揮発層を含むため tail は付けない)。
        let out3 = build_system_payload(
            &AiProvider::Anthropic,
            "claude-sonnet-4-6",
            "FULL",
            None,
            Some("L5_SUMMARY"),
        );
        assert_eq!(out3, serde_json::Value::String("FULL".to_string()));
    }

    #[test]
    fn build_openai_chat_messages_plain_when_not_claude_or_no_segments() {
        let msgs = [("system", "S"), ("user", "hi")];
        let segs = vec!["L1".to_string()];
        // 非 Claude モデル → cache_control 無し (tail があっても plain のまま)。
        let out = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "openai/gpt-5.5",
            Some(&segs),
            Some("TAIL"),
        );
        assert_eq!(out[0]["content"], "S");
        // Claude だが segments 無し → plain。
        let out2 = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "anthropic/claude-4.6-sonnet",
            None,
            None,
        );
        assert_eq!(out2[0]["content"], "S");
        // 空 segments → plain (block 0 件)。
        let empty: Vec<String> = vec![String::new()];
        let out3 = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "anthropic/claude-4.6-sonnet",
            Some(&empty),
            None,
        );
        assert_eq!(out3[0]["content"], "S");
    }

    #[test]
    fn build_openai_chat_messages_only_first_system_gets_blocks() {
        // system が複数あっても segments を載せるのは先頭 1 つだけ (二重適用を防ぐ)。
        let msgs = [("system", "S1"), ("system", "S2"), ("user", "hi")];
        let segs = vec!["L1".to_string()];
        let out = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "anthropic/claude-4.6-sonnet",
            Some(&segs),
            None,
        );
        assert!(out[0]["content"].is_array());
        assert_eq!(out[1]["content"], "S2");
    }

    #[test]
    fn apply_openrouter_provider_pin_injects_when_openrouter_and_pin_set() {
        let mut body = serde_json::json!({ "model": "anthropic/claude-4.6-sonnet" });
        apply_openrouter_provider_pin(&mut body, &AiProvider::OpenRouter, Some("anthropic"));
        assert_eq!(body["provider"]["order"][0], "anthropic");
        assert_eq!(body["provider"]["allow_fallbacks"], true);
    }

    #[test]
    fn resolve_api_variant_forces_chat_completions_for_fusion() {
        // openrouter/fusion は Responses トグル ON でも /chat/completions に通すこと
        // (/responses 経路 = ai_responses は fusion plugin を注入しないため、ここで
        // responses を握り潰さないと fusion が無言で既定パネルに落ちる)。
        let settings = AiSettings {
            provider: AiProvider::OpenRouter,
            model_api_variant: Some("responses".to_string()),
            ..AiSettings::default()
        };
        // 明示 responses でも settings responses でも None(=chat/completions)。
        assert_eq!(
            resolve_api_variant(Some("responses"), &settings, "openrouter/fusion"),
            None
        );
        assert_eq!(
            resolve_api_variant(None, &settings, "openrouter/fusion"),
            None
        );
        // 通常モデルは responses を維持する(回帰防止)。
        assert_eq!(
            resolve_api_variant(Some("responses"), &settings, "anthropic/claude-4.6-sonnet"),
            Some("responses".to_string())
        );
    }

    // --- OpenRouter Fusion plugin injection ---

    fn fusion_cfg(enabled: bool, panel: &[&str], judge: Option<&str>) -> FusionConfig {
        FusionConfig {
            enabled,
            analysis_models: panel.iter().map(|s| s.to_string()).collect(),
            judge_model: judge.map(|s| s.to_string()),
        }
    }

    #[test]
    fn fusion_injects_plugin_when_enabled_with_panel_and_judge() {
        let cfg = fusion_cfg(
            true,
            &["anthropic/claude-opus-4-8", "openai/gpt-5"],
            Some("openai/gpt-5"),
        );
        let mut body = serde_json::json!({ "model": "openrouter/fusion" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openrouter/fusion",
            Some(&cfg),
        );
        assert_eq!(body["plugins"][0]["id"], "fusion");
        assert_eq!(
            body["plugins"][0]["analysis_models"][0],
            "anthropic/claude-opus-4-8"
        );
        assert_eq!(body["plugins"][0]["analysis_models"][1], "openai/gpt-5");
        assert_eq!(body["plugins"][0]["model"], "openai/gpt-5");
    }

    #[test]
    fn fusion_appends_to_existing_plugins_without_clobbering() {
        // web plugin が既にあっても fusion を追加するだけ (上書きしない)。
        let cfg = fusion_cfg(true, &["openai/gpt-5"], None);
        let mut body = serde_json::json!({
            "model": "openrouter/fusion",
            "plugins": [{ "id": "web", "max_results": 5 }]
        });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openrouter/fusion",
            Some(&cfg),
        );
        let plugins = body["plugins"].as_array().unwrap();
        assert_eq!(plugins.len(), 2);
        assert_eq!(plugins[0]["id"], "web");
        assert_eq!(plugins[1]["id"], "fusion");
        // judge 未指定なら model キーは省く。
        assert!(plugins[1].get("model").is_none());
    }

    #[test]
    fn fusion_noop_when_disabled_or_empty_or_wrong_model_or_provider() {
        let enabled_panel = fusion_cfg(true, &["openai/gpt-5"], None);

        // disabled → 注入しない (素の openrouter/fusion = 既定パネル)。
        let mut body = serde_json::json!({ "model": "openrouter/fusion" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openrouter/fusion",
            Some(&fusion_cfg(false, &["openai/gpt-5"], Some("openai/gpt-5"))),
        );
        assert!(body.get("plugins").is_none());

        // enabled だが panel/judge 空 (空白のみ) → 注入しない。
        let mut body = serde_json::json!({ "model": "openrouter/fusion" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openrouter/fusion",
            Some(&fusion_cfg(true, &["  ", ""], Some("  "))),
        );
        assert!(body.get("plugins").is_none());

        // model が openrouter/fusion 以外 → 注入しない。
        let mut body = serde_json::json!({ "model": "openai/gpt-5" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openai/gpt-5",
            Some(&enabled_panel),
        );
        assert!(body.get("plugins").is_none());

        // provider が OpenRouter 以外 → 注入しない。
        let mut body = serde_json::json!({ "model": "openrouter/fusion" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenAI,
            "openrouter/fusion",
            Some(&enabled_panel),
        );
        assert!(body.get("plugins").is_none());

        // fusion config 自体が None → 注入しない。
        let mut body = serde_json::json!({ "model": "openrouter/fusion" });
        apply_openrouter_fusion_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            "openrouter/fusion",
            None,
        );
        assert!(body.get("plugins").is_none());
    }

    #[test]
    fn apply_openrouter_provider_pin_noop_when_pin_empty() {
        let mut body = serde_json::json!({ "model": "x" });
        apply_openrouter_provider_pin(&mut body, &AiProvider::OpenRouter, Some(""));
        assert!(body.get("provider").is_none());
        apply_openrouter_provider_pin(&mut body, &AiProvider::OpenRouter, Some("   "));
        assert!(body.get("provider").is_none());
        apply_openrouter_provider_pin(&mut body, &AiProvider::OpenRouter, None);
        assert!(body.get("provider").is_none());
    }

    #[test]
    fn apply_openrouter_provider_pin_noop_when_not_openrouter() {
        let mut body = serde_json::json!({ "model": "x" });
        apply_openrouter_provider_pin(&mut body, &AiProvider::OpenAI, Some("anthropic"));
        assert!(body.get("provider").is_none());
        apply_openrouter_provider_pin(&mut body, &AiProvider::Anthropic, Some("anthropic"));
        assert!(body.get("provider").is_none());
    }

    // --- post_effect_openai_user_content: content 形状のプロバイダ分岐 ---
    // Ollama 等のローカル OpenAI 互換サーバはパーツ配列 content を 400 で拒否
    // する実装があるため、cache_control が意味を持つ OpenRouter 以外は
    // プレーン文字列に平坦化する（チャット経路と同形）。

    #[test]
    fn post_effect_user_content_is_plain_string_for_ollama() {
        let v = post_effect_openai_user_content(&AiProvider::Ollama, None, "本文");
        assert_eq!(v, serde_json::json!("[Scene]\n本文"));
    }

    #[test]
    fn post_effect_user_content_flattens_codex_for_local_providers() {
        let v = post_effect_openai_user_content(
            &AiProvider::OpenaiCompatible,
            Some("{\"entries\":[]}"),
            "本文",
        );
        assert_eq!(
            v,
            serde_json::json!("[Codex]\n{\"entries\":[]}\n\n[Scene]\n本文")
        );
    }

    #[test]
    fn post_effect_user_content_keeps_blocks_with_cache_control_for_openrouter() {
        let v = post_effect_openai_user_content(&AiProvider::OpenRouter, Some("codex"), "本文");
        let blocks = v.as_array().expect("array content");
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["cache_control"]["type"], "ephemeral");
        assert_eq!(blocks[0]["text"], "[Codex]\ncodex");
        assert_eq!(blocks[1]["text"], "[Scene]\n本文");
        assert!(blocks[1].get("cache_control").is_none());
    }

    #[test]
    fn apply_openrouter_web_search_agentic_pushes_server_tool() {
        // agentic: 既存 tools[] へ server tool を追加する。
        let mut body = serde_json::json!({ "tools": [{ "type": "function", "name": "f" }] });
        let ws = WebSearchConfig {
            enabled: true,
            agentic: true,
            ..Default::default()
        };
        apply_openrouter_web_search_to_body(&mut body, &AiProvider::OpenRouter, Some(&ws));
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[1]["type"], "openrouter:web_search");
        assert!(body.get("plugins").is_none());
    }

    #[test]
    fn apply_openrouter_web_search_agentic_creates_tools_when_absent() {
        // Responses 経路は tools キーを省きうる。agentic で配列が無ければ新規作成する。
        let mut body = serde_json::json!({ "model": "x" });
        let ws = WebSearchConfig {
            enabled: true,
            agentic: true,
            ..Default::default()
        };
        apply_openrouter_web_search_to_body(&mut body, &AiProvider::OpenRouter, Some(&ws));
        let tools = body["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["type"], "openrouter:web_search");
    }

    #[test]
    fn apply_openrouter_web_search_plugin_sets_plugins() {
        // 非 agentic: web plugin を plugins[] に載せる(max_results 既定 5)。
        let mut body = serde_json::json!({ "model": "x" });
        let ws = WebSearchConfig {
            enabled: true,
            agentic: false,
            ..Default::default()
        };
        apply_openrouter_web_search_to_body(&mut body, &AiProvider::OpenRouter, Some(&ws));
        assert_eq!(body["plugins"][0]["id"], "web");
        assert_eq!(body["plugins"][0]["max_results"], 5);
        // exa 制御はドメイン/ content cap 未指定なので付かない。
        assert!(body["plugins"][0].get("engine").is_none());
    }

    #[test]
    fn apply_openrouter_web_search_exa_when_domain_filter() {
        // ドメイン制御指定時のみ engine=exa を強制する。
        let mut body = serde_json::json!({ "model": "x" });
        let ws = WebSearchConfig {
            enabled: true,
            agentic: false,
            allowed_domains: vec!["example.com".to_string()],
            ..Default::default()
        };
        apply_openrouter_web_search_to_body(&mut body, &AiProvider::OpenRouter, Some(&ws));
        assert_eq!(body["plugins"][0]["engine"], "exa");
        assert_eq!(body["plugins"][0]["allowed_domains"][0], "example.com");
    }

    #[test]
    fn apply_openrouter_web_search_noop_when_disabled_or_not_openrouter() {
        // enabled=false / provider 違い / web_search 無し は何もしない。
        let ws_off = WebSearchConfig {
            enabled: false,
            ..Default::default()
        };
        let mut body = serde_json::json!({ "model": "x" });
        apply_openrouter_web_search_to_body(&mut body, &AiProvider::OpenRouter, Some(&ws_off));
        assert!(body.get("plugins").is_none() && body.get("tools").is_none());

        let ws_on = WebSearchConfig {
            enabled: true,
            agentic: false,
            ..Default::default()
        };
        let mut body2 = serde_json::json!({ "model": "x" });
        apply_openrouter_web_search_to_body(&mut body2, &AiProvider::OpenAI, Some(&ws_on));
        assert!(body2.get("plugins").is_none());

        let mut body3 = serde_json::json!({ "model": "x" });
        apply_openrouter_web_search_to_body(&mut body3, &AiProvider::OpenRouter, None);
        assert!(body3.get("plugins").is_none());
    }

    #[test]
    fn apply_stream_usage_optin_openrouter_uses_usage_include() {
        // N4: OpenRouter はネイティブの usage:{include:true} を使う (cost も返る)。
        let mut body = serde_json::json!({ "model": "x", "stream": true });
        apply_stream_usage_optin(&mut body, &AiProvider::OpenRouter);
        assert_eq!(body["usage"]["include"], true);
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn apply_stream_usage_optin_openai_uses_stream_options() {
        // OpenAI / OpenAI 互換は標準の stream_options.include_usage。
        for provider in [AiProvider::OpenAI, AiProvider::OpenaiCompatible] {
            let mut body = serde_json::json!({ "model": "x", "stream": true });
            apply_stream_usage_optin(&mut body, &provider);
            assert_eq!(body["stream_options"]["include_usage"], true);
            assert!(body.get("usage").is_none());
        }
    }

    #[test]
    fn apply_stream_usage_optin_ollama_and_others_noop() {
        // Ollama は既定で usage を返すため触らない (未知フィールドでの 400 回避)。
        for provider in [
            AiProvider::Ollama,
            AiProvider::Anthropic,
            AiProvider::AiNovelist,
        ] {
            let mut body = serde_json::json!({ "model": "x", "stream": true });
            apply_stream_usage_optin(&mut body, &provider);
            assert!(body.get("usage").is_none());
            assert!(body.get("stream_options").is_none());
        }
    }

    #[test]
    fn test_default_ai_settings() {
        let settings = AiSettings::default();
        assert_eq!(settings.provider, AiProvider::OpenRouter);
        assert!(settings.model.is_empty());
        assert_eq!(settings.ollama_endpoint, "http://localhost:11434");
    }

    #[test]
    fn test_ai_settings_roundtrip() {
        let dir = temp_path("settings_roundtrip");
        let path = dir.join("ai-settings.json");
        cleanup(&path);
        fs::create_dir_all(&dir).ok();

        let settings = AiSettings {
            provider: AiProvider::OpenAI,
            model: "gpt-4o".to_string(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            thinking_enabled: true,
            openai_compatible: OpenaiCompatibleSettings::default(),
            openai_compatible_endpoints: Vec::new(),
            active_openai_compatible_endpoint_id: None,
            ai_novelist: AiNovelistSettings::default(),
            cli: None,
            openrouter_provider_pin: None,
            model_api_variant: None,
            reasoning_effort_override: Some("high".to_string()),
            tool_protocol_mode: ToolProtocolMode::default(),
            fusion: FusionConfig::default(),
        };

        write_ai_settings(&path, &settings).expect("write");
        let loaded = read_ai_settings(&path);

        assert_eq!(loaded.provider, AiProvider::OpenAI);
        assert_eq!(loaded.model, "gpt-4o");
        // save 往復で override が消えないこと（SHIP-BREAKER B）。
        assert_eq!(loaded.reasoning_effort_override.as_deref(), Some("high"));

        cleanup(&path);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_read_ai_settings_missing_returns_default() {
        let path = temp_path("settings_missing").join("nonexistent.json");
        let settings = read_ai_settings(&path);
        assert_eq!(settings.provider, AiProvider::OpenRouter);
    }

    #[test]
    fn test_read_ai_settings_invalid_json_returns_default() {
        let dir = temp_path("settings_invalid");
        let path = dir.join("ai-settings.json");
        fs::create_dir_all(&dir).ok();
        fs::write(&path, "not json").ok();

        let settings = read_ai_settings(&path);
        assert_eq!(settings.provider, AiProvider::OpenRouter);

        cleanup(&path);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_provider_base_urls() {
        let ep = ProviderEndpoints::new("http://localhost:11434", "");
        assert_eq!(
            AiProvider::OpenRouter.base_url(ep),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(AiProvider::OpenAI.base_url(ep), "https://api.openai.com/v1");
        assert_eq!(
            AiProvider::Anthropic.base_url(ep),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            AiProvider::Ollama.base_url(ep),
            "http://localhost:11434/api"
        );
    }

    #[test]
    fn test_provider_openai_compat_base_url() {
        let ep = ProviderEndpoints::new("http://localhost:11434", "");
        // Ollama uses /v1 for OpenAI-compatible endpoints
        assert_eq!(
            AiProvider::Ollama.openai_compat_base_url(ep, None),
            "http://localhost:11434/v1"
        );
        // Other providers unchanged
        assert_eq!(
            AiProvider::OpenRouter.openai_compat_base_url(ep, None),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            AiProvider::OpenAI.openai_compat_base_url(ep, None),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            AiProvider::AiNovelist.openai_compat_base_url(ep, Some("v1")),
            ai_novelist::V1_BASE_URL
        );
    }

    #[test]
    fn test_openai_compatible_uses_custom_url() {
        let ep = ProviderEndpoints::new("", "http://localhost:1234/v1");
        assert_eq!(
            AiProvider::OpenaiCompatible.base_url(ep),
            "http://localhost:1234/v1"
        );
        // openai_compat_base_url falls through to base_url for OpenaiCompatible
        assert_eq!(
            AiProvider::OpenaiCompatible.openai_compat_base_url(ep, None),
            "http://localhost:1234/v1"
        );
        // Trailing slash trimmed
        let ep2 = ProviderEndpoints::new("", "http://localhost:1234/v1/");
        assert_eq!(
            AiProvider::OpenaiCompatible.base_url(ep2),
            "http://localhost:1234/v1"
        );
    }

    #[test]
    fn test_openai_compatible_models_url() {
        let ep = ProviderEndpoints::new("", "http://localhost:1234/v1");
        assert_eq!(
            AiProvider::OpenaiCompatible.models_url(ep, None),
            "http://localhost:1234/v1/models"
        );
    }

    #[test]
    fn test_provider_display() {
        assert_eq!(AiProvider::OpenRouter.to_string(), "openrouter");
        assert_eq!(AiProvider::OpenAI.to_string(), "openai");
        assert_eq!(AiProvider::Anthropic.to_string(), "anthropic");
        assert_eq!(AiProvider::Ollama.to_string(), "ollama");
        assert_eq!(
            AiProvider::OpenaiCompatible.to_string(),
            "openai-compatible"
        );
        assert_eq!(AiProvider::AiNovelist.to_string(), "ai-novelist");
    }

    #[test]
    fn test_provider_serde_roundtrip() {
        let json = serde_json::to_string(&AiProvider::OpenRouter).expect("serialize");
        assert_eq!(json, "\"openrouter\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::OpenRouter);

        let json = serde_json::to_string(&AiProvider::OpenaiCompatible).expect("serialize");
        assert_eq!(json, "\"openai-compatible\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::OpenaiCompatible);

        let json = serde_json::to_string(&AiProvider::AiNovelist).expect("serialize");
        assert_eq!(json, "\"ai-novelist\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::AiNovelist);
    }

    #[test]
    fn test_ai_novelist_base_url() {
        let ep = ProviderEndpoints::default();
        assert_eq!(
            AiProvider::AiNovelist.base_url(ep),
            "https://api.tringpt.com/api"
        );
        assert_eq!(AiProvider::AiNovelist.models_url(ep, None), "");
        assert_eq!(
            AiProvider::AiNovelist.models_url(ep, Some("v1")),
            ai_novelist::V1_MODELS_URL
        );
    }

    #[test]
    fn test_merge_ainoverist_models_v1_wins_on_duplicate_id() {
        let legacy = vec![legacy_ainoverist_model("spiko", "spiko")];
        let v1 = vec![v1_ainoverist_model("spiko_ultra", "Spiko Ultra")];
        let merged = merge_ainoverist_models(legacy, v1);
        assert_eq!(merged.len(), 2);
        let ultra = merged.iter().find(|m| m.id == "spiko_ultra").unwrap();
        assert_eq!(ultra.api_variant.as_deref(), Some("v1"));
    }

    #[test]
    fn test_apply_reasoning_to_body_ainoverist_v1_flat_effort() {
        let mut body = serde_json::json!({});
        apply_reasoning_to_body(
            &mut body,
            &AiProvider::AiNovelist,
            Some("v1"),
            "spiko_ultra",
            Some(true),
            &Some("high".to_string()),
        );
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn test_apply_reasoning_to_body_ainoverist_legacy_skips() {
        let mut body = serde_json::json!({});
        apply_reasoning_to_body(
            &mut body,
            &AiProvider::AiNovelist,
            Some("legacy"),
            "spiko_ultra",
            Some(true),
            &Some("high".to_string()),
        );
        assert!(body.as_object().unwrap().is_empty());
    }

    #[test]
    fn test_apply_reasoning_openrouter_on_off() {
        // ON: effort 指定なし → medium
        let mut body = serde_json::json!({});
        apply_reasoning_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            None,
            "openai/gpt-5",
            Some(true),
            &None,
        );
        assert_eq!(body["reasoning"], serde_json::json!({ "effort": "medium" }));

        // ON: low/high passthrough, max → xhigh
        for (input, expected) in [("low", "low"), ("high", "high"), ("max", "xhigh")] {
            let mut body = serde_json::json!({});
            apply_reasoning_to_body(
                &mut body,
                &AiProvider::OpenRouter,
                None,
                "qwen/qwen3",
                Some(true),
                &Some(input.to_string()),
            );
            assert_eq!(body["reasoning"]["effort"], expected);
        }

        // OFF (toggleable) → effort:none
        let mut body = serde_json::json!({});
        apply_reasoning_to_body(
            &mut body,
            &AiProvider::OpenRouter,
            None,
            "qwen/qwen3",
            Some(false),
            &None,
        );
        assert_eq!(body["reasoning"], serde_json::json!({ "effort": "none" }));
    }

    #[test]
    fn test_apply_reasoning_openai_direct() {
        // ON: passthrough、max → high
        for (input, expected) in [
            ("low", "low"),
            ("medium", "medium"),
            ("high", "high"),
            ("max", "high"),
        ] {
            let mut body = serde_json::json!({});
            apply_reasoning_to_body(
                &mut body,
                &AiProvider::OpenAI,
                None,
                "gpt-5.1",
                Some(true),
                &Some(input.to_string()),
            );
            assert_eq!(body["reasoning_effort"], expected);
            assert!(
                body.get("reasoning").is_none(),
                "OpenAI は reasoning object を使わない"
            );
        }

        // OFF: gpt-5.1+ は none、それ以前/o3 はキー無し
        let mut body = serde_json::json!({});
        apply_reasoning_to_body(
            &mut body,
            &AiProvider::OpenAI,
            None,
            "gpt-5.1",
            Some(false),
            &None,
        );
        assert_eq!(body["reasoning_effort"], "none");

        for model in ["gpt-5", "o3", "o4-mini"] {
            let mut body = serde_json::json!({});
            apply_reasoning_to_body(
                &mut body,
                &AiProvider::OpenAI,
                None,
                model,
                Some(false),
                &None,
            );
            assert!(
                body.get("reasoning_effort").is_none(),
                "{model}: none 非対応モデルに disabling を送ってはいけない"
            );
        }
    }

    #[test]
    fn test_apply_reasoning_openai_gpt5_pro_clamps_high() {
        for input in ["low", "medium", "high"] {
            let mut body = serde_json::json!({});
            apply_reasoning_to_body(
                &mut body,
                &AiProvider::OpenAI,
                None,
                "gpt-5-pro",
                Some(true),
                &Some(input.to_string()),
            );
            assert_eq!(body["reasoning_effort"], "high");
        }
    }

    #[test]
    fn test_openai_model_supports_reasoning_none() {
        for m in [
            "gpt-5.1",
            "gpt-5-1",
            "gpt-5.4-mini",
            "openai/gpt-5.1",
            "gpt-5.2",
        ] {
            assert!(
                openai_model_supports_reasoning_none(m),
                "{m} は none 対応のはず"
            );
        }
        for m in [
            "gpt-5",
            "gpt-5-mini",
            "o3",
            "o4-mini",
            "gpt-5-pro",
            "gpt-5-chat",
        ] {
            assert!(
                !openai_model_supports_reasoning_none(m),
                "{m} は none 非対応のはず"
            );
        }
    }

    #[test]
    fn test_openai_model_requires_high_effort() {
        assert!(openai_model_requires_high_effort("gpt-5-pro"));
        assert!(openai_model_requires_high_effort("openai/gpt-5-pro"));
        assert!(!openai_model_requires_high_effort("gpt-5.1"));
        assert!(!openai_model_requires_high_effort("gpt-5"));
    }

    #[test]
    fn test_insert_chat_completion_token_limit_key() {
        let mut body = serde_json::json!({});
        insert_chat_completion_token_limit(&mut body, &AiProvider::OpenAI, 32_000);
        assert_eq!(body["max_completion_tokens"], 32_000);
        assert!(body.get("max_tokens").is_none());

        let mut body = serde_json::json!({});
        insert_chat_completion_token_limit(&mut body, &AiProvider::OpenRouter, 4096);
        assert_eq!(body["max_tokens"], 4096);
        assert!(body.get("max_completion_tokens").is_none());
    }

    #[test]
    fn test_is_openrouter_reasoning_model() {
        // 推論モデル(provider プレフィックス有無どちらも検出する)。
        for m in [
            "openai/gpt-5",
            "openai/gpt-5-mini",
            "openai/gpt-5-pro",
            "gpt-5",
            "openai/gpt-5-2025-08-01", // 日付サフィックスでも検出
            "openai/o1",
            "openai/o1-mini",
            "openai/o3-mini",
            "openai/o4-mini",
            "deepseek/deepseek-r1",
            "deepseek-r1",
        ] {
            assert!(is_openrouter_reasoning_model(m), "expected reasoning: {m}");
        }
        // 非 reasoning(gpt-5-chat は明示除外・その他通常モデル)。
        for m in [
            "openai/gpt-5-chat",
            "gpt-5-chat",
            "openai/gpt-4o-mini",
            "openai/gpt-4o",
            "anthropic/claude-opus-4-8",
            "meta-llama/llama-3.1-70b-instruct",
        ] {
            assert!(
                !is_openrouter_reasoning_model(m),
                "expected non-reasoning: {m}"
            );
        }
    }

    #[test]
    fn test_openai_max_tokens_openrouter_reasoning_headroom() {
        // OpenRouter provider で model 名だけ差し替えて openai_max_tokens を測る。
        fn mt(settings: &AiSettings, model: &'static str) -> u32 {
            let params = ChatParams {
                provider: &AiProvider::OpenRouter,
                model,
                api_key: "sk-test",
                endpoints: settings.endpoints(),
                thinking: None,
                effort: None,
                reasoning_enabled: None,
                reasoning_effort: None,
                extra_body: None,
                retry_429: false,
                ai_novelist_mode: AiNovelistMode::Chat,
                openrouter_provider_pin: None,
                system_cache_segments: None,
                system_volatile_tail: None,
                api_variant: None,
                web_search: None,
                fusion: None,
                resolved_tool_protocol: ResolvedToolProtocol::Native,
            };
            openai_max_tokens(&params)
        }
        let settings = AiSettings::default();
        // OpenRouter 経由の reasoning モデルは 32k へ(hidden reasoning 予算枯渇の回避)。
        assert_eq!(mt(&settings, "openai/gpt-5"), 32_000);
        assert_eq!(mt(&settings, "openai/gpt-5-pro"), 32_000);
        assert_eq!(mt(&settings, "deepseek/deepseek-r1"), 32_000);
        // 非 reasoning は従来どおり 4096。
        assert_eq!(mt(&settings, "openai/gpt-4o-mini"), 4096);
        // gpt-5-chat は非 reasoning 扱いで 4096。
        assert_eq!(mt(&settings, "openai/gpt-5-chat"), 4096);
    }

    #[test]
    fn test_parse_openai_response_reads_reasoning_field() {
        // canonical `reasoning` フィールドから Thinking ブロックを取り出す。
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": { "content": "本文", "reasoning": "考えた内容" }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let resp = parse_openai_response(&json, &ParseOpenAIOptions::default()).unwrap();
        let thinking: Vec<_> = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Thinking { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, vec!["考えた内容".to_string()]);
    }

    // ----- Hermes tool protocol -----

    fn hermes_opts(allowed: &[&str]) -> ParseOpenAIOptions {
        ParseOpenAIOptions {
            resolved_protocol: ResolvedToolProtocol::Hermes,
            allowed_tool_names: allowed.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn collect_tool_uses(resp: &ChatResponse) -> Vec<(String, String, serde_json::Value)> {
        resp.blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::ToolUse { id, name, input } => {
                    Some((id.clone(), name.clone(), input.clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn collect_text(resp: &ChatResponse) -> String {
        resp.blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Text { content } => Some(content.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn hermes_single_tool_call_is_parsed() {
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "検索します。\n<tool_call>{\"name\":\"search_codex\",\"arguments\":{\"query\":\"朱音\"}}</tool_call>"
                }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let resp = parse_openai_response(&json, &hermes_opts(&["search_codex"])).unwrap();
        // finish_reason が "stop" でも tool_use に上書きされる。
        assert_eq!(resp.stop_reason, "tool_use");
        let tus = collect_tool_uses(&resp);
        assert_eq!(tus.len(), 1);
        assert_eq!(tus[0].1, "search_codex");
        assert_eq!(tus[0].2["query"], "朱音");
        let text = collect_text(&resp);
        assert!(text.contains("検索します"));
        assert!(!text.contains("<tool_call>"));
    }

    #[test]
    fn hermes_allowed_tool_names_drops_mutating_tools() {
        let tool = |n: &str| AgentToolDef {
            name: n.to_string(),
            description: String::new(),
            input_schema: serde_json::json!({}),
        };
        let tools = vec![
            tool("search_codex"),
            tool("create_codex_entry"),
            tool("get_scene"),
            tool("propose_scene_body"),
            tool("apply_ai_tree_plan"),
        ];
        let allowed = hermes_allowed_tool_names(&tools);
        // read tools survive, mutating ones are filtered out.
        assert!(allowed.contains(&"search_codex".to_string()));
        assert!(allowed.contains(&"get_scene".to_string()));
        assert!(!allowed.contains(&"create_codex_entry".to_string()));
        assert!(!allowed.contains(&"propose_scene_body".to_string()));
        assert!(!allowed.contains(&"apply_ai_tree_plan".to_string()));
    }

    #[test]
    fn hermes_body_mutating_tool_call_is_not_executed() {
        // A Web-search result echoed into the body as a create_codex_entry
        // <tool_call> must NOT become a ToolUse, even though it is "declared".
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "<tool_call>{\"name\":\"create_codex_entry\",\"arguments\":{\"name\":\"x\"}}</tool_call>"
                }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let tools = vec![AgentToolDef {
            name: "create_codex_entry".to_string(),
            description: String::new(),
            input_schema: serde_json::json!({}),
        }];
        let opts = ParseOpenAIOptions {
            resolved_protocol: ResolvedToolProtocol::Hermes,
            allowed_tool_names: hermes_allowed_tool_names(&tools),
            ..Default::default()
        };
        let resp = parse_openai_response(&json, &opts).unwrap();
        assert!(collect_tool_uses(&resp).is_empty());
    }

    #[test]
    fn hermes_multiple_newline_and_input_key() {
        let content = "<tool_call>\n{\"name\": \"search_codex\", \"arguments\": {\"query\": \"a\"}}\n</tool_call>\n<tool_call>{\"name\":\"get_codex_entry\",\"input\":{\"id\":\"x1\"}}</tool_call>";
        let json = serde_json::json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": content } }],
            "usage": {}
        });
        let resp = parse_openai_response(&json, &hermes_opts(&["search_codex", "get_codex_entry"]))
            .unwrap();
        let tus = collect_tool_uses(&resp);
        let names: Vec<&str> = tus.iter().map(|t| t.1.as_str()).collect();
        assert_eq!(names, vec!["search_codex", "get_codex_entry"]);
        // `input` キーも `arguments` と同様に正規化される。
        assert_eq!(tus[1].2["id"], "x1");
        assert_eq!(resp.stop_reason, "tool_use");
    }

    #[test]
    fn hermes_unknown_broken_and_empty_allowed_yield_no_tooluse_but_strip() {
        let content = "前文\n<tool_call>{\"name\":\"unknown_tool\",\"arguments\":{}}</tool_call>\n<tool_call>{壊れた</tool_call>\n後文";
        let json = serde_json::json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": content } }],
            "usage": {}
        });
        // allowed=search_codex のみ → unknown も broken も ToolUse 化しない。
        let resp = parse_openai_response(&json, &hermes_opts(&["search_codex"])).unwrap();
        assert_eq!(collect_tool_uses(&resp).len(), 0);
        assert_eq!(resp.stop_reason, "end_turn");
        let text = collect_text(&resp);
        assert!(text.contains("前文"));
        assert!(text.contains("後文"));
        assert!(!text.contains("<tool_call>"));

        // allowed=[] (非 tools chat 経路) でも ToolUse なし + タグ除去。
        let opts_empty = ParseOpenAIOptions {
            resolved_protocol: ResolvedToolProtocol::Hermes,
            allowed_tool_names: vec![],
            ..Default::default()
        };
        let resp2 = parse_openai_response(&json, &opts_empty).unwrap();
        assert_eq!(collect_tool_uses(&resp2).len(), 0);
        assert!(!collect_text(&resp2).contains("<tool_call>"));
    }

    #[test]
    fn hermes_native_tool_calls_take_precedence_over_body() {
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": "<tool_call>{\"name\":\"search_codex\",\"arguments\":{\"query\":\"body\"}}</tool_call>",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "search_codex", "arguments": "{\"query\":\"native\"}" }
                    }]
                }
            }],
            "usage": {}
        });
        let resp = parse_openai_response(&json, &hermes_opts(&["search_codex"])).unwrap();
        let tus = collect_tool_uses(&resp);
        // native の 1 件のみ (本文 <tool_call> はパースしない=二重実行防止)。
        assert_eq!(tus.len(), 1);
        assert_eq!(tus[0].0, "call_1");
        assert_eq!(tus[0].2["query"], "native");
        assert_eq!(resp.stop_reason, "tool_use");
    }

    // ----- native channel mutating block (low-trust providers / security F-6) -----

    fn native_opts(block_mutating_on_native: bool) -> ParseOpenAIOptions {
        ParseOpenAIOptions {
            resolved_protocol: ResolvedToolProtocol::Native,
            block_mutating_on_native,
            ..Default::default()
        }
    }

    /// native `tool_calls` を持つ OpenAI 互換レスポンス JSON を組む。
    fn native_tool_calls_json(calls: &[(&str, &str)]) -> serde_json::Value {
        let tcs: Vec<serde_json::Value> = calls
            .iter()
            .map(|(id, name)| {
                serde_json::json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": "{\"name\":\"x\"}" }
                })
            })
            .collect();
        serde_json::json!({
            "choices": [{
                "finish_reason": "tool_calls",
                "message": { "content": "", "tool_calls": tcs }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        })
    }

    #[test]
    fn native_mutating_tool_call_blocked_on_low_trust() {
        // 間接インジェクションで弱い local モデルが native の create_codex_entry を
        // emit しても、低信頼プロバイダでは ToolUse 化されず破棄される。
        let json = native_tool_calls_json(&[("c1", "create_codex_entry")]);
        let resp = parse_openai_response(&json, &native_opts(true)).unwrap();
        assert!(collect_tool_uses(&resp).is_empty());
        // 全 skip で tool_use 昇格を取り消し end_turn に戻す。
        assert_eq!(resp.stop_reason, "end_turn");
    }

    #[test]
    fn native_read_only_tool_call_survives_low_trust() {
        // read-only ツールは低信頼プロバイダでも通る（過剰ブロック回帰防止）。
        let json = native_tool_calls_json(&[("c1", "search_codex")]);
        let resp = parse_openai_response(&json, &native_opts(true)).unwrap();
        let tus = collect_tool_uses(&resp);
        assert_eq!(tus.len(), 1);
        assert_eq!(tus[0].1, "search_codex");
        assert_eq!(resp.stop_reason, "tool_use");
    }

    #[test]
    fn native_mutating_tool_call_allowed_on_frontier() {
        // frontier（block=false）では native の mutating ツールが従来どおり通る。
        let json = native_tool_calls_json(&[("c1", "create_codex_entry")]);
        let resp = parse_openai_response(&json, &native_opts(false)).unwrap();
        let tus = collect_tool_uses(&resp);
        assert_eq!(tus.len(), 1);
        assert_eq!(tus[0].1, "create_codex_entry");
        assert_eq!(resp.stop_reason, "tool_use");
    }

    #[test]
    fn native_mixed_calls_drops_only_mutating_on_low_trust() {
        let json = native_tool_calls_json(&[("c1", "create_codex_entry"), ("c2", "search_codex")]);
        let resp = parse_openai_response(&json, &native_opts(true)).unwrap();
        let tus = collect_tool_uses(&resp);
        assert_eq!(tus.len(), 1);
        assert_eq!(tus[0].1, "search_codex");
        assert_eq!(resp.stop_reason, "tool_use");
    }

    #[test]
    fn is_low_trust_native_provider_set() {
        assert!(is_low_trust_native_provider(&AiProvider::Ollama));
        assert!(is_low_trust_native_provider(&AiProvider::OpenaiCompatible));
        assert!(is_low_trust_native_provider(&AiProvider::AiNovelist));
        assert!(!is_low_trust_native_provider(&AiProvider::OpenRouter));
        assert!(!is_low_trust_native_provider(&AiProvider::OpenAI));
        assert!(!is_low_trust_native_provider(&AiProvider::Anthropic));
        assert!(!is_low_trust_native_provider(&AiProvider::Cli));
    }

    #[test]
    fn hermes_blocked_tool_names_are_frozen() {
        // 両チャネル(Hermes 本文 + 低信頼 native)の唯一の真実源。TS 側
        // MUTATING_TOOL_NAMES (src/features/chat/toolProtocolParse.ts) /
        // MUTATING_EXECUTORS (src/features/chat/agent/toolExecutors.ts) とドリフト
        // したら、両言語を一緒に更新すること。
        let mut got: Vec<&str> = HERMES_BLOCKED_TOOL_NAMES.to_vec();
        got.sort_unstable();
        let mut want = vec![
            "apply_ai_tree_plan",
            "create_codex_entry",
            "create_foreshadow",
            "create_snippet",
            "propose_scene_body",
            "update_codex_entry",
            "update_foreshadow",
        ];
        want.sort_unstable();
        assert_eq!(got, want);
    }

    #[test]
    fn resolve_tool_protocol_gate_and_auto() {
        // provider ゲート: Anthropic / CLI は mode 無視で Native。
        assert_eq!(
            resolve_tool_protocol(
                &AiProvider::Anthropic,
                "nous-hermes",
                ToolProtocolMode::Hermes
            ),
            ResolvedToolProtocol::Native
        );
        assert_eq!(
            resolve_tool_protocol(&AiProvider::Cli, "hermes", ToolProtocolMode::Auto),
            ResolvedToolProtocol::Native
        );
        // 明示。
        assert_eq!(
            resolve_tool_protocol(&AiProvider::OpenRouter, "gpt-4", ToolProtocolMode::Hermes),
            ResolvedToolProtocol::Hermes
        );
        assert_eq!(
            resolve_tool_protocol(
                &AiProvider::OpenRouter,
                "nousresearch/hermes-3",
                ToolProtocolMode::Native
            ),
            ResolvedToolProtocol::Native
        );
        // auto: model 名に hermes を含むときのみ。
        assert_eq!(
            resolve_tool_protocol(
                &AiProvider::OpenRouter,
                "nousresearch/Hermes-3-Llama",
                ToolProtocolMode::Auto
            ),
            ResolvedToolProtocol::Hermes
        );
        assert_eq!(
            resolve_tool_protocol(
                &AiProvider::OpenRouter,
                "qwen/qwen-2.5-72b",
                ToolProtocolMode::Auto
            ),
            ResolvedToolProtocol::Native
        );
    }

    #[test]
    fn hermes_tool_protocol_mode_serde_wire_boundary() {
        // 保存設定 JSON (camelCase) → enum。send_agent_message が read_ai_settings で
        // 読む wire 境界を担保する（store.test.ts は API 層 mock のため Rust serde 未通過）。
        let with: AiSettings = serde_json::from_str(
            r#"{"provider":"openrouter","model":"x","ollamaEndpoint":"http://localhost:11434","toolProtocolMode":"hermes"}"#,
        )
        .unwrap();
        assert_eq!(with.tool_protocol_mode, ToolProtocolMode::Hermes);

        // フィールド欠落 → default Auto（旧設定 JSON との後方互換）。
        let without: AiSettings = serde_json::from_str(
            r#"{"provider":"openrouter","model":"x","ollamaEndpoint":"http://localhost:11434"}"#,
        )
        .unwrap();
        assert_eq!(without.tool_protocol_mode, ToolProtocolMode::Auto);

        // serialize は camelCase + lowercase 値で出力する。
        let json = serde_json::to_value(&with).unwrap();
        assert_eq!(json["toolProtocolMode"], "hermes");
    }

    // ----- Hermes 送信側 (Phase B) -----

    fn td(name: &str) -> AgentToolDef {
        AgentToolDef {
            name: name.to_string(),
            description: format!("{name} desc"),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    #[test]
    fn hermes_outbound_omits_tools_and_injects_system_xml() {
        let msgs = vec![
            AgentMessage::System {
                content: "システム指示".to_string(),
            },
            AgentMessage::User {
                content: "質問".to_string(),
            },
        ];
        let out = build_hermes_openai_messages(&msgs, &[td("search_codex")]);
        let sys = out.iter().find(|m| m["role"] == "system").unwrap();
        let sys_content = sys["content"].as_str().unwrap();
        assert!(sys_content.contains("システム指示"));
        assert!(sys_content.contains("<tools>"));
        assert!(sys_content.contains("search_codex"));
        // native tool 構造 (tool_calls / role:"tool") は一切出さない。
        for m in &out {
            assert!(m.get("tool_calls").is_none());
            assert_ne!(m["role"], "tool");
        }
    }

    #[test]
    fn hermes_outbound_encodes_assistant_and_tool_result() {
        let msgs = vec![
            AgentMessage::System {
                content: "S".to_string(),
            },
            AgentMessage::User {
                content: "U".to_string(),
            },
            AgentMessage::Assistant {
                content: "呼びます".to_string(),
                tool_uses: vec![ToolUsePayload {
                    id: "hermes-0".to_string(),
                    name: "search_codex".to_string(),
                    input: serde_json::json!({ "query": "朱音" }),
                }],
                thinking_blocks: vec![],
            },
            AgentMessage::ToolResult {
                tool_use_id: "hermes-0".to_string(),
                content: "{\"ok\":true}".to_string(),
                is_error: false,
            },
        ];
        let out = build_hermes_openai_messages(&msgs, &[td("search_codex")]);
        // assistant は <tool_call> テキスト、tool_calls キー無し。
        let asst = out.iter().find(|m| m["role"] == "assistant").unwrap();
        let asst_content = asst["content"].as_str().unwrap();
        assert!(asst_content.contains("<tool_call>"));
        assert!(asst_content.contains("search_codex"));
        assert!(asst_content.contains("朱音"));
        assert!(asst.get("tool_calls").is_none());
        // tool_result は role:"user" の <tool_response> (name 付き)。
        let tr = out.iter().rev().find(|m| m["role"] == "user").unwrap();
        let tr_content = tr["content"].as_str().unwrap();
        assert!(tr_content.contains("<tool_response>"));
        assert!(tr_content.contains("search_codex"));
        assert!(tr_content.contains("ok"));
    }

    #[test]
    fn hermes_outbound_tool_call_roundtrips_through_parser() {
        let encoded = format_hermes_tool_call("search_codex", &serde_json::json!({ "query": "x" }));
        let (_stripped, calls) = parse_hermes_tool_calls(&encoded, &["search_codex".to_string()]);
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "search_codex");
        assert_eq!(calls[0].input["query"], "x");
    }

    #[test]
    fn hermes_outbound_adds_system_when_absent() {
        let out = build_hermes_openai_messages(
            &[AgentMessage::User {
                content: "U".to_string(),
            }],
            &[td("search_codex")],
        );
        assert_eq!(out[0]["role"], "system");
        assert!(out[0]["content"].as_str().unwrap().contains("<tools>"));
    }

    #[test]
    fn truncate_for_log_respects_char_boundary() {
        assert_eq!(truncate_for_log("abc", 10), "abc");
        let out = truncate_for_log("あいうえお", 2);
        assert!(out.starts_with("あい"));
        assert!(out.contains("+3 chars"));
    }

    #[test]
    fn test_parse_openai_response_reasoning_no_duplicate() {
        // reasoning と reasoning_content が両方ある場合は reasoning を 1 つだけ採用。
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "本文",
                    "reasoning": "canonical",
                    "reasoning_content": "alias"
                }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let resp = parse_openai_response(&json, &ParseOpenAIOptions::default()).unwrap();
        let thinking: Vec<_> = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Thinking { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, vec!["canonical".to_string()]);
    }

    #[test]
    fn test_parse_openai_response_falls_back_to_reasoning_content() {
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": { "content": "本文", "reasoning_content": "alias のみ" }
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let resp = parse_openai_response(&json, &ParseOpenAIOptions::default()).unwrap();
        let thinking: Vec<_> = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Thinking { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(thinking, vec!["alias のみ".to_string()]);
    }

    #[test]
    fn test_ollama_endpoint_trailing_slash() {
        let ep = ProviderEndpoints::new("http://localhost:11434/", "");
        assert_eq!(
            AiProvider::Ollama.base_url(ep),
            "http://localhost:11434/api"
        );
    }

    #[test]
    fn test_ai_settings_endpoints_helper() {
        let mut settings = AiSettings::default();
        settings.openai_compatible.base_url = "http://localhost:8080/v1".to_string();
        let ep = settings.endpoints();
        assert_eq!(ep.ollama, "http://localhost:11434");
        assert_eq!(ep.openai_compat_custom, "http://localhost:8080/v1");
    }

    #[test]
    fn test_flatten_messages_for_ainoverist() {
        let messages = vec![("system", "あなたは小説家"), ("user", "続きを書いて")];
        let text = flatten_messages_for_ainoverist(&messages);
        assert_eq!(text, "[system]\nあなたは小説家\n\n[user]\n続きを書いて");
    }

    #[test]
    fn test_parse_ainoverist_response_with_array_data() {
        let json = serde_json::json!({ "data": ["生成テキスト"] });
        let resp = parse_ainoverist_response(&json).unwrap();
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "生成テキスト"),
            _ => panic!("expected Text"),
        }
        assert_eq!(resp.stop_reason, "end_turn");
    }

    #[test]
    fn test_parse_ainoverist_response_with_string_data() {
        let json = serde_json::json!({ "data": "直接の文字列" });
        let resp = parse_ainoverist_response(&json).unwrap();
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "直接の文字列"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn test_parse_ainoverist_response_missing_data_errors() {
        let json = serde_json::json!({ "error": "auth" });
        assert!(parse_ainoverist_response(&json).is_err());
    }

    #[test]
    fn test_parse_ainoverist_response_empty_data_returns_no_blocks() {
        let json = serde_json::json!({ "data": [""] });
        let resp = parse_ainoverist_response(&json).unwrap();
        assert!(resp.blocks.is_empty());
    }

    #[test]
    fn test_parse_ainoverist_response_text_completion_shape() {
        // 現行 vLLM 風レスポンス: data がオブジェクトで choices[0].text を持つ
        let json = serde_json::json!({
            "data": {
                "0": "本文テキスト",
                "choices": [{
                    "finish_reason": "length",
                    "index": 0,
                    "text": "本文テキスト",
                }],
                "usage": {
                    "completion_tokens": 175,
                    "prompt_tokens": -1,
                    "total_tokens": -1,
                }
            }
        });
        let resp = parse_ainoverist_response(&json).unwrap();
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "本文テキスト"),
            _ => panic!("expected Text"),
        }
        assert_eq!(resp.stop_reason, "length");
        // -1 は弾く / completion_tokens から採用
        assert_eq!(resp.input_tokens, None);
        assert_eq!(resp.output_tokens, Some(175));
    }

    #[test]
    fn test_parse_ainoverist_response_object_data_falls_back_to_zero_key() {
        // choices が無いケースは data["0"] にフォールバック
        let json = serde_json::json!({
            "data": { "0": "テキスト" }
        });
        let resp = parse_ainoverist_response(&json).unwrap();
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "テキスト"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn test_build_ainoverist_body_includes_required_fields() {
        let messages = vec![("user", "続き")];
        let body = build_ainoverist_body("spiko", &messages, &None);
        assert_eq!(body["text"], "[user]\n続き");
        assert_eq!(body["model"], "spiko");
        // length はモデルの max output (spiko = 4096)
        assert_eq!(body["length"], 4_096);
    }

    #[test]
    fn test_build_ainoverist_body_unknown_model_uses_default_length() {
        let body = build_ainoverist_body("unknown", &[("user", "x")], &None);
        assert_eq!(body["length"], 400);
    }

    #[test]
    fn test_build_ainoverist_body_extra_body_does_not_override_length() {
        let extra = Some(serde_json::json!({
            "length": 99_999,
            "top_a": 0.1,
        }));
        let body = build_ainoverist_body("spiko", &[("user", "x")], &extra);
        // length は保護される (merge_extra_body は or_insert)
        assert_eq!(body["length"], 4_096);
        // sampling パラメータは素通し
        assert_eq!(body["top_a"], 0.1);
    }

    #[test]
    fn test_messages_to_chat_array_system_folded_into_first_user() {
        let msgs = vec![("system", "指示"), ("user", "質問"), ("assistant", "回答")];
        let arr = messages_to_chat_array(&msgs);
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[0]["content"], "指示\n\n質問");
        assert_eq!(arr[1]["role"], "assistant");
        assert_eq!(arr[1]["content"], "回答");
    }

    #[test]
    fn test_messages_to_chat_array_system_only_becomes_user() {
        let msgs = vec![("system", "指示のみ")];
        let arr = messages_to_chat_array(&msgs);
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["role"], "user");
        assert_eq!(arr[0]["content"], "指示のみ");
    }

    #[test]
    fn test_remap_extra_body_for_chat_renames_rep_pen() {
        let extra = Some(serde_json::json!({ "rep_pen": 1.15, "top_p": 0.9, "top_a": 0.1 }));
        let remapped = remap_extra_body_for_chat(&extra).unwrap();
        let obj = remapped.as_object().unwrap();
        assert!(!obj.contains_key("rep_pen"), "rep_pen should be renamed");
        assert_eq!(remapped["repetition_penalty"], 1.15);
        assert_eq!(remapped["top_p"], 0.9);
        assert_eq!(remapped["top_a"], 0.1);
    }

    #[test]
    fn test_build_ainoverist_chat_body_uses_messages_and_max_tokens() {
        let msgs = vec![("user", "こんにちは")];
        let body = build_ainoverist_chat_body("spiko", &msgs, &None);
        assert!(body["messages"].is_array());
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "こんにちは");
        assert_eq!(body["model"], "spiko");
        assert_eq!(body["max_tokens"], 4_096);
        assert!(
            body.get("text").is_none(),
            "chat body must not have text field"
        );
        assert!(
            body.get("length").is_none(),
            "chat body must not have length field"
        );
    }

    #[test]
    fn test_parse_ainoverist_response_chat_api_shape() {
        // Chat API: choices[0].text が空文字、本文は data["0"]
        let json = serde_json::json!({
            "data": {
                "0": "こんにちは！",
                "choices": [{ "finish_reason": "stop", "text": "" }],
                "usage": { "completion_tokens": 10, "prompt_tokens": -1 }
            }
        });
        let resp = parse_ainoverist_response(&json).unwrap();
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "こんにちは！"),
            _ => panic!("expected Text"),
        }
        assert_eq!(resp.stop_reason, "stop");
    }

    #[test]
    fn test_strip_think_blocks_removes_single_block() {
        let input = "<think>\n内部思考\n</think>\n本文テキスト";
        assert_eq!(strip_think_blocks(input), "本文テキスト");
    }

    #[test]
    fn test_strip_think_blocks_removes_multiple_blocks() {
        let input = "<think>A</think>\n<think>B</think>\n応答";
        assert_eq!(strip_think_blocks(input), "応答");
    }

    #[test]
    fn test_strip_think_blocks_no_blocks_unchanged() {
        assert_eq!(strip_think_blocks("普通のテキスト"), "普通のテキスト");
    }

    #[test]
    fn test_strip_think_blocks_unclosed_tag_drops_rest() {
        let input = "前半<think>閉じない";
        assert_eq!(strip_think_blocks(input), "前半");
    }

    #[test]
    fn test_parse_ainoverist_response_strips_think_blocks() {
        let json = serde_json::json!({
            "data": {
                "0": "<think>\n内部思考\n</think>\nこんにちは！",
                "choices": [{ "finish_reason": "stop", "text": "" }]
            }
        });
        let resp = parse_ainoverist_response(&json).unwrap();
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "こんにちは！"),
            _ => panic!("expected Text"),
        }
    }

    #[test]
    fn test_parse_anthropic_response_extracts_web_search_citations() {
        // web_search 使用時: text ブロックに citations、加えて server_tool_use /
        // web_search_tool_result ブロックが混在する。引用のみ抽出し、サーバツール
        // ブロックは無視する (クライアント tool_use 扱いしない)。
        let json = serde_json::json!({
            "stop_reason": "end_turn",
            "content": [
                { "type": "server_tool_use", "id": "srv_1", "name": "web_search",
                  "input": { "query": "Edo period currency" } },
                { "type": "web_search_tool_result", "tool_use_id": "srv_1",
                  "content": [{ "type": "web_search_result", "url": "https://x" }] },
                {
                    "type": "text",
                    "text": "江戸時代の通貨は両でした。",
                    "citations": [
                        { "type": "web_search_result_location",
                          "url": "https://example.com/edo",
                          "title": "Edo currency",
                          "cited_text": "一両は四千文に相当した" },
                        // 同一 URL の重複は 1 件に畳む
                        { "type": "web_search_result_location",
                          "url": "https://example.com/edo",
                          "title": "Edo currency",
                          "cited_text": "別の抜粋" }
                    ]
                }
            ],
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        });
        let resp = parse_anthropic_response(&json).unwrap();
        assert_eq!(resp.stop_reason, "end_turn");
        // server_tool_use は ResponseBlock::ToolUse にならない (text のみ)
        assert_eq!(resp.blocks.len(), 1);
        assert!(matches!(resp.blocks[0], ResponseBlock::Text { .. }));
        assert_eq!(resp.citations.len(), 1);
        assert_eq!(resp.citations[0].url, "https://example.com/edo");
        assert_eq!(resp.citations[0].cited_text, "一両は四千文に相当した");
        assert_eq!(resp.cost, None);
    }

    #[test]
    fn test_parse_openai_response_extracts_url_citations_and_cost() {
        // OpenRouter web plugin / server tool は annotations.url_citation で統一。
        let json = serde_json::json!({
            "choices": [{
                "finish_reason": "stop",
                "message": {
                    "content": "回答本文",
                    "annotations": [
                        { "type": "url_citation", "url_citation": {
                            "url": "https://news.example/article",
                            "title": "記事タイトル",
                            "content": "引用抜粋",
                            "start_index": 0, "end_index": 4 } },
                        { "type": "url_citation", "url_citation": {
                            "url": "https://news.example/article",
                            "title": "記事タイトル",
                            "content": "重複" } }
                    ]
                }
            }],
            "usage": { "prompt_tokens": 5, "completion_tokens": 7, "cost": 0.0123 }
        });
        let resp = parse_openai_response(&json, &ParseOpenAIOptions::default()).unwrap();
        assert_eq!(resp.citations.len(), 1);
        assert_eq!(resp.citations[0].url, "https://news.example/article");
        assert_eq!(resp.citations[0].cited_text, "引用抜粋");
        assert_eq!(resp.cost, Some(0.0123));
    }

    #[test]
    fn test_parse_openai_response_no_annotations_yields_empty_citations() {
        let json = serde_json::json!({
            "choices": [{ "finish_reason": "stop", "message": { "content": "hi" } }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 }
        });
        let resp = parse_openai_response(&json, &ParseOpenAIOptions::default()).unwrap();
        assert!(resp.citations.is_empty());
        assert_eq!(resp.cost, None);
    }

    #[test]
    fn test_web_search_config_caps_default_when_zero() {
        let cfg = WebSearchConfig {
            enabled: true,
            agentic: false,
            max_results: 0,
            max_uses: 0,
            ..Default::default()
        };
        assert_eq!(cfg.results_cap(), 5);
        assert_eq!(cfg.uses_cap(), 3);
        let cfg2 = WebSearchConfig {
            enabled: true,
            agentic: true,
            max_results: 8,
            max_uses: 2,
            ..Default::default()
        };
        assert_eq!(cfg2.results_cap(), 8);
        assert_eq!(cfg2.uses_cap(), 2);
    }

    // ── Phase 2: ドメイン制御 / content cap ─────────────────────────────────

    #[test]
    fn test_web_search_config_domain_filter_prefers_allowed() {
        // allowed と blocked が両方あっても allowed を優先（Anthropic は両方同時不可）。
        let cfg = WebSearchConfig {
            enabled: true,
            allowed_domains: vec!["a.com".into(), "b.org".into()],
            blocked_domains: vec!["spam.example".into()],
            ..Default::default()
        };
        let (is_allow, domains) = cfg.domain_filter().expect("filter present");
        assert!(is_allow);
        assert_eq!(domains, &["a.com".to_string(), "b.org".to_string()]);
    }

    #[test]
    fn test_web_search_config_domain_filter_blocked_when_no_allowed() {
        let cfg = WebSearchConfig {
            enabled: true,
            blocked_domains: vec!["spam.example".into()],
            ..Default::default()
        };
        let (is_allow, domains) = cfg.domain_filter().expect("filter present");
        assert!(!is_allow);
        assert_eq!(domains, &["spam.example".to_string()]);
    }

    #[test]
    fn test_web_search_config_domain_filter_none_when_empty() {
        let cfg = WebSearchConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(cfg.domain_filter().is_none());
    }

    #[test]
    fn test_web_search_config_needs_exa_engine() {
        // 制御なし → auto のまま（exa 強制しない＝コスト退行防止）。
        let plain = WebSearchConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(!plain.needs_exa_engine());
        // ドメイン制御あり → exa 強制。
        let with_domains = WebSearchConfig {
            enabled: true,
            blocked_domains: vec!["x.com".into()],
            ..Default::default()
        };
        assert!(with_domains.needs_exa_engine());
        // content cap あり → exa 強制。
        let with_cap = WebSearchConfig {
            enabled: true,
            max_content_tokens: 4000,
            ..Default::default()
        };
        assert!(with_cap.needs_exa_engine());
    }

    #[test]
    fn test_build_anthropic_web_search_tool_basic() {
        let cfg = WebSearchConfig {
            enabled: true,
            max_uses: 2,
            // Anthropic には content cap が無いので渡しても無視されるべき。
            max_content_tokens: 4000,
            ..Default::default()
        };
        let tool = build_anthropic_web_search_tool(&cfg);
        assert_eq!(tool["type"], ANTHROPIC_WEB_SEARCH_TYPE);
        assert_eq!(tool["name"], "web_search");
        assert_eq!(tool["max_uses"], 2);
        assert!(tool.get("allowed_domains").is_none());
        assert!(tool.get("blocked_domains").is_none());
        // max_content_tokens は Anthropic ツールには絶対に付けない。
        assert!(tool.get("max_content_tokens").is_none());
    }

    #[test]
    fn test_build_anthropic_web_search_tool_allowed_only() {
        let cfg = WebSearchConfig {
            enabled: true,
            allowed_domains: vec!["docs.example.com".into()],
            blocked_domains: vec!["spam.example".into()],
            ..Default::default()
        };
        let tool = build_anthropic_web_search_tool(&cfg);
        assert_eq!(
            tool["allowed_domains"],
            serde_json::json!(["docs.example.com"])
        );
        // allowed があるとき blocked は送らない（排他制約）。
        assert!(tool.get("blocked_domains").is_none());
    }

    #[test]
    fn test_build_anthropic_web_search_tool_blocked() {
        let cfg = WebSearchConfig {
            enabled: true,
            blocked_domains: vec!["spam.example".into()],
            ..Default::default()
        };
        let tool = build_anthropic_web_search_tool(&cfg);
        assert_eq!(tool["blocked_domains"], serde_json::json!(["spam.example"]));
        assert!(tool.get("allowed_domains").is_none());
    }

    #[test]
    fn test_apply_openrouter_web_controls_allowed_and_cap() {
        let cfg = WebSearchConfig {
            enabled: true,
            allowed_domains: vec!["a.com".into()],
            max_content_tokens: 3000,
            ..Default::default()
        };
        let mut plugin = serde_json::json!({ "id": "web", "max_results": 5 });
        apply_openrouter_web_controls(&mut plugin, &cfg);
        assert_eq!(plugin["engine"], "exa");
        assert_eq!(plugin["allowed_domains"], serde_json::json!(["a.com"]));
        assert!(plugin.get("blocked_domains").is_none());
        assert_eq!(plugin["max_content_tokens"], 3000);
        // 既存フィールドは保持。
        assert_eq!(plugin["id"], "web");
        assert_eq!(plugin["max_results"], 5);
    }

    #[test]
    fn test_apply_openrouter_web_controls_blocked_no_cap() {
        let cfg = WebSearchConfig {
            enabled: true,
            blocked_domains: vec!["x.com".into()],
            ..Default::default()
        };
        let mut tool = serde_json::json!({ "type": "openrouter:web_search" });
        apply_openrouter_web_controls(&mut tool, &cfg);
        assert_eq!(tool["engine"], "exa");
        assert_eq!(tool["blocked_domains"], serde_json::json!(["x.com"]));
        assert!(tool.get("allowed_domains").is_none());
        // max_content_tokens=0 のときは付けない。
        assert!(tool.get("max_content_tokens").is_none());
    }

    #[test]
    fn apply_thinking_adaptive_maps_effort_to_output_config() {
        let mut body = serde_json::json!({ "model": "claude-sonnet-4-6" });
        super::apply_thinking_to_body(
            &mut body,
            &Some(ThinkingConfig::Adaptive {
                effort: "high".to_string(),
                display: Some("summarized".to_string()),
            }),
            &None,
        );
        assert_eq!(body["thinking"]["type"], "adaptive");
        assert_eq!(body["thinking"]["display"], "summarized");
        assert!(body["thinking"].get("effort").is_none());
        assert_eq!(body["output_config"]["effort"], "high");
        assert!(body.get("effort").is_none());
    }

    #[test]
    fn apply_thinking_enabled_maps_effort_to_output_config() {
        let mut body = serde_json::json!({ "model": "claude-opus-4-5" });
        super::apply_thinking_to_body(
            &mut body,
            &Some(ThinkingConfig::Enabled {
                budget_tokens: 8000,
                display: None,
            }),
            &Some("medium".to_string()),
        );
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["thinking"]["budget_tokens"], 8000);
        assert!(body["thinking"].get("effort").is_none());
        assert_eq!(body["output_config"]["effort"], "medium");
        assert!(body.get("effort").is_none());
    }

    #[test]
    fn apply_thinking_effort_only_maps_to_output_config() {
        let mut body = serde_json::json!({ "model": "claude-haiku-4-5-20251001" });
        super::apply_thinking_to_body(&mut body, &None, &Some("low".to_string()));
        assert!(body.get("thinking").is_none());
        assert_eq!(body["output_config"]["effort"], "low");
        assert!(body.get("effort").is_none());
    }

    #[test]
    fn anthropic_beta_headers_prompt_cache_and_manual_thinking() {
        let settings = AiSettings::default();
        let api_key = "sk-test";
        let segments = vec!["seg1".to_string()];
        let params = ChatParams {
            provider: &AiProvider::Anthropic,
            model: "claude-opus-4-5",
            api_key,
            endpoints: settings.endpoints(),
            thinking: Some(ThinkingConfig::Enabled {
                budget_tokens: 4000,
                display: None,
            }),
            effort: Some("high".to_string()),
            reasoning_enabled: None,
            reasoning_effort: None,
            extra_body: None,
            retry_429: false,
            ai_novelist_mode: AiNovelistMode::Chat,
            openrouter_provider_pin: None,
            system_cache_segments: Some(segments),
            system_volatile_tail: None,
            api_variant: None,
            web_search: None,
            fusion: None,
            resolved_tool_protocol: ResolvedToolProtocol::Native,
        };
        let betas = super::anthropic_beta_headers(&params).unwrap();
        assert!(betas.contains("prompt-caching-2024-07-31"));
        assert!(betas.contains("interleaved-thinking-2025-05-14"));
    }

    #[test]
    fn anthropic_beta_headers_adaptive_no_interleaved_beta() {
        let settings = AiSettings::default();
        let params = ChatParams {
            provider: &AiProvider::Anthropic,
            model: "claude-sonnet-4-6",
            api_key: "sk-test",
            endpoints: settings.endpoints(),
            thinking: Some(ThinkingConfig::Adaptive {
                effort: "medium".to_string(),
                display: None,
            }),
            effort: None,
            reasoning_enabled: None,
            reasoning_effort: None,
            extra_body: None,
            retry_429: false,
            ai_novelist_mode: AiNovelistMode::Chat,
            openrouter_provider_pin: None,
            system_cache_segments: None,
            system_volatile_tail: None,
            api_variant: None,
            web_search: None,
            fusion: None,
            resolved_tool_protocol: ResolvedToolProtocol::Native,
        };
        assert!(super::anthropic_beta_headers(&params).is_none());
    }

    #[test]
    fn parse_anthropic_http_error_extracts_message() {
        let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"effort: Extra inputs are not permitted"}}"#;
        let err = super::parse_anthropic_http_error(reqwest::StatusCode::BAD_REQUEST, body);
        assert!(err.to_string().contains("400"));
        assert!(err.to_string().contains("Extra inputs are not permitted"));
    }

    // -----------------------------------------------------------------------
    // parse_openrouter_model
    // -----------------------------------------------------------------------

    #[test]
    fn parse_openrouter_model_full() {
        let m = serde_json::json!({
            "id": "anthropic/claude-sonnet-4.6",
            "name": "Claude Sonnet 4.6",
            "context_length": 1000000,
            "top_provider": { "max_completion_tokens": 64000 },
            "supported_parameters": ["tools", "reasoning", "temperature"],
            "pricing": { "prompt": "0.000003", "completion": "0.000015" }
        });
        let model = super::parse_openrouter_model(&m).unwrap();
        assert_eq!(model.id, "anthropic/claude-sonnet-4.6");
        assert_eq!(model.name, "Claude Sonnet 4.6");
        assert_eq!(model.context_length, Some(1_000_000));
        assert_eq!(model.max_completion_tokens, Some(64_000));
        let params = model.supported_parameters.as_ref().unwrap();
        assert!(params.contains(&"tools".to_string()));
        assert!(params.contains(&"reasoning".to_string()));
        assert_eq!(model.pricing_prompt.as_deref(), Some("0.000003"));
        assert_eq!(model.pricing_completion.as_deref(), Some("0.000015"));
    }

    #[test]
    fn parse_openrouter_model_missing_optional_fields() {
        let m = serde_json::json!({
            "id": "anthropic/claude-opus-4-6",
            "name": "Claude Opus 4.6"
        });
        let model = super::parse_openrouter_model(&m).unwrap();
        assert_eq!(model.id, "anthropic/claude-opus-4-6");
        assert_eq!(model.context_length, None);
        assert_eq!(model.max_completion_tokens, None);
        assert_eq!(model.supported_parameters, None);
        assert_eq!(model.pricing_prompt, None);
    }

    #[test]
    fn parse_openrouter_model_context_length_null() {
        let m = serde_json::json!({
            "id": "anthropic/claude-haiku-4-5",
            "context_length": null
        });
        let model = super::parse_openrouter_model(&m).unwrap();
        assert_eq!(model.context_length, None);
    }

    #[test]
    fn parse_openrouter_model_top_provider_missing() {
        let m = serde_json::json!({
            "id": "some/model",
            "context_length": 32768
        });
        let model = super::parse_openrouter_model(&m).unwrap();
        assert_eq!(model.context_length, Some(32_768));
        assert_eq!(model.max_completion_tokens, None);
    }

    #[test]
    fn parse_openrouter_model_non_string_parameters_skipped() {
        let m = serde_json::json!({
            "id": "some/model",
            "supported_parameters": ["tools", 42, null, "reasoning"]
        });
        let model = super::parse_openrouter_model(&m).unwrap();
        let params = model.supported_parameters.as_ref().unwrap();
        assert_eq!(params, &["tools".to_string(), "reasoning".to_string()]);
    }

    #[test]
    fn parse_openrouter_model_missing_id_returns_none() {
        let m = serde_json::json!({ "name": "No ID Model" });
        assert!(super::parse_openrouter_model(&m).is_none());
    }

    #[test]
    fn aimodel_serde_roundtrip_camel_case_none_omitted() {
        let model = super::AiModel {
            id: "anthropic/claude-opus-4-6".to_string(),
            name: "Claude Opus 4.6".to_string(),
            api_variant: None,
            context_length: Some(1_000_000),
            max_completion_tokens: Some(128_000),
            supported_parameters: Some(vec!["reasoning".to_string()]),
            pricing_prompt: None,
            pricing_completion: None,
        };
        let json = serde_json::to_value(&model).unwrap();
        // camelCase rename
        assert_eq!(json["contextLength"], 1_000_000);
        assert_eq!(json["maxCompletionTokens"], 128_000);
        // None フィールドは出力されない (skip_serializing_if)
        assert!(json.get("apiVariant").is_none());
        assert!(json.get("pricingPrompt").is_none());
    }
}

// ---------------------------------------------------------------------------
// A/B 比較 (③) — 枠ごとの別プロバイダ override のライブ検証。既定 SKIP。
//
// A/B chat の 1 枠は send_chat_message(provider 引数) 経由で `send_chat` を
// effective provider の ChatParams で叩く。ここではその `send_chat` 経路を
// プロバイダごとに実 API へ流して「別プロバイダが本当に応答するか」を確認する。
// Sakana は A/B dispatcher が apiVariant="responses" を渡すのと同じく responses 経路。
//
//   OPENROUTER_API_KEY=sk-or-... \
//   OPENAI_API_KEY=sk-proj-...   \
//   ANTHROPIC_API_KEY=sk-ant-... \
//   SAKANA_API_KEY=fish_...      \
//     cargo test --no-default-features ab_live -- --nocapture
//
// モデル上書き: OPENROUTER_AB_MODEL / OPENAI_AB_MODEL / ANTHROPIC_AB_MODEL /
// SAKANA_AB_MODEL。キー未設定の枠は個別に [skip] する (CI / sandbox 安全)。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod ab_provider_live_tests {
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    }

    fn key_of(names: &[&str]) -> Option<String> {
        names
            .iter()
            .find_map(|n| std::env::var(n).ok().filter(|k| !k.is_empty()))
    }

    /// A/B 1 枠相当の ChatParams を組む (build_chat_params と同じ形・effective provider)。
    fn ab_params<'a>(
        provider: &'a AiProvider,
        settings: &'a AiSettings,
        key: &'a str,
        model: &'a str,
        api_variant: Option<String>,
    ) -> ChatParams<'a> {
        ChatParams {
            provider,
            model,
            api_key: key,
            endpoints: settings.endpoints(),
            thinking: None,
            effort: None,
            reasoning_enabled: None,
            reasoning_effort: None,
            extra_body: None,
            retry_429: true,
            ai_novelist_mode: AiNovelistMode::Chat,
            openrouter_provider_pin: None,
            system_cache_segments: None,
            system_volatile_tail: None,
            api_variant,
            web_search: None,
            fusion: None,
            resolved_tool_protocol: ResolvedToolProtocol::Native,
        }
    }

    /// 1 枠を実行し本文テキストを返す (空なら panic)。
    fn run(label: &str, params: &ChatParams<'_>) -> String {
        let messages = [(
            "user",
            "Reply with exactly the single word: pong. No punctuation.",
        )];
        let resp = rt()
            .block_on(send_chat(params, &messages))
            .unwrap_or_else(|e| panic!("{label}: send_chat 失敗: {e:#}"));
        let text: String = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert!(!text.trim().is_empty(), "{label}: 本文テキストが空");
        eprintln!("[ok] {label}: {} chars => {text:?}", text.chars().count());
        text
    }

    #[test]
    fn ab_live_openrouter() {
        let Some(key) = key_of(&["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"]) else {
            eprintln!("[skip] ab_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let model =
            std::env::var("OPENROUTER_AB_MODEL").unwrap_or_else(|_| "openai/gpt-4o-mini".into());
        let settings = AiSettings {
            provider: AiProvider::OpenRouter,
            model: model.clone(),
            ..Default::default()
        };
        run(
            "ab_live_openrouter",
            &ab_params(&AiProvider::OpenRouter, &settings, &key, &model, None),
        );
    }

    #[test]
    fn ab_live_openai() {
        let Some(key) = key_of(&["OPENAI_API_KEY"]) else {
            eprintln!("[skip] ab_live_openai: OPENAI_API_KEY 未設定");
            return;
        };
        // gpt-5 系: OpenAI 直は max_completion_tokens 32k 前提なので completion 上限の
        // 大きい現行モデルを既定にする (gpt-4o-mini は 16384 上限で 400 になる)。
        let model = std::env::var("OPENAI_AB_MODEL").unwrap_or_else(|_| "gpt-5-mini".into());
        let settings = AiSettings {
            provider: AiProvider::OpenAI,
            model: model.clone(),
            ..Default::default()
        };
        run(
            "ab_live_openai",
            &ab_params(&AiProvider::OpenAI, &settings, &key, &model, None),
        );
    }

    #[test]
    fn ab_live_anthropic() {
        let Some(key) = key_of(&["ANTHROPIC_API_KEY"]) else {
            eprintln!("[skip] ab_live_anthropic: ANTHROPIC_API_KEY 未設定");
            return;
        };
        let model = std::env::var("ANTHROPIC_AB_MODEL")
            .unwrap_or_else(|_| "claude-haiku-4-5-20251001".into());
        let settings = AiSettings {
            provider: AiProvider::Anthropic,
            model: model.clone(),
            ..Default::default()
        };
        run(
            "ab_live_anthropic",
            &ab_params(&AiProvider::Anthropic, &settings, &key, &model, None),
        );
    }

    #[test]
    fn ab_live_sakana() {
        let Some(key) = key_of(&["SAKANA_API_KEY"]) else {
            eprintln!("[skip] ab_live_sakana: SAKANA_API_KEY 未設定");
            return;
        };
        // A/B dispatcher が Sakana 枠に渡すのと同じ responses 経路。
        let model = std::env::var("SAKANA_AB_MODEL").unwrap_or_else(|_| "fugu".into());
        let settings = AiSettings {
            provider: AiProvider::Sakana,
            model: model.clone(),
            ..Default::default()
        };
        run(
            "ab_live_sakana",
            &ab_params(
                &AiProvider::Sakana,
                &settings,
                &key,
                &model,
                Some("responses".to_string()),
            ),
        );
    }

    /// OpenRouter Fusion (マルチモデル合議) のカスタム構成を実 API で検証する。
    /// パネル/judge は FUSION_PANEL (カンマ区切り) / FUSION_JUDGE で上書き可。
    /// 注意: Fusion はパネル数 + judge ぶん課金される (既定 2 + 1 = 約 3 completion)。
    ///   OPENROUTER_API_KEY=sk-or-... cargo test --no-default-features fusion_live -- --nocapture
    #[test]
    fn fusion_live_openrouter() {
        let Some(key) = key_of(&["OPENROUTER_API_KEY", "OPEN_ROUTER_API_KEY"]) else {
            eprintln!("[skip] fusion_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let panel: Vec<String> = std::env::var("FUSION_PANEL")
            .unwrap_or_else(|_| "openai/gpt-4o-mini,anthropic/claude-3.5-haiku".into())
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let judge = std::env::var("FUSION_JUDGE").unwrap_or_else(|_| "openai/gpt-4o-mini".into());
        let cfg = FusionConfig {
            enabled: true,
            analysis_models: panel,
            judge_model: Some(judge),
        };
        let settings = AiSettings {
            provider: AiProvider::OpenRouter,
            model: "openrouter/fusion".into(),
            ..Default::default()
        };
        let params = ChatParams {
            provider: &AiProvider::OpenRouter,
            model: "openrouter/fusion",
            api_key: &key,
            endpoints: settings.endpoints(),
            thinking: None,
            effort: None,
            reasoning_enabled: None,
            reasoning_effort: None,
            extra_body: None,
            retry_429: true,
            ai_novelist_mode: AiNovelistMode::Chat,
            openrouter_provider_pin: None,
            system_cache_segments: None,
            system_volatile_tail: None,
            api_variant: None,
            web_search: None,
            fusion: Some(&cfg),
            resolved_tool_protocol: ResolvedToolProtocol::Native,
        };
        run("fusion_live_openrouter", &params);
    }
}
