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
    #[serde(rename = "ai-novelist")]
    AiNovelist,
    #[serde(rename = "cli")]
    Cli,
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
}

impl AiSettings {
    pub fn endpoints(&self) -> ProviderEndpoints<'_> {
        ProviderEndpoints {
            ollama: &self.ollama_endpoint,
            openai_compat_custom: &self.openai_compatible.base_url,
        }
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
            ai_novelist: AiNovelistSettings::default(),
            cli: None,
            openrouter_provider_pin: None,
            model_api_variant: None,
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
}

fn legacy_ainoverist_model(id: &str, name: &str) -> AiModel {
    AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: Some("legacy".to_string()),
    }
}

fn v1_ainoverist_model(id: &str, name: &str) -> AiModel {
    AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: Some("v1".to_string()),
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
    if let Some(v) = explicit.filter(|s| !s.is_empty()) {
        return Some(v.to_string());
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

fn openai_max_tokens(params: &ChatParams<'_>) -> u32 {
    if is_ainoverist_v1(params) {
        ai_novelist::length_for(params.model)
    } else {
        4096
    }
}

/// Read AI settings from the given file path.
pub fn read_ai_settings(path: &Path) -> AiSettings {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => AiSettings::default(),
    }
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

/// Save an API key to the OS keyring.
pub fn save_api_key(provider: &AiProvider, key: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(provider.keyring_service(), KEYRING_USER)?;
    entry.set_password(key)?;
    Ok(())
}

/// Get an API key from the OS keyring. Returns None if not found.
pub fn get_api_key(provider: &AiProvider) -> anyhow::Result<Option<String>> {
    let entry = keyring::Entry::new(provider.keyring_service(), KEYRING_USER)?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::anyhow!("Keyring error: {e}")),
    }
}

/// Delete an API key from the OS keyring.
pub fn delete_api_key(provider: &AiProvider) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(provider.keyring_service(), KEYRING_USER)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // Already gone
        Err(e) => Err(anyhow::anyhow!("Keyring error: {e}")),
    }
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
                    id: "claude-sonnet-4-6".to_string(),
                    name: "Claude Sonnet 4.6".to_string(),
                    api_variant: None,
                },
                AiModel {
                    id: "claude-haiku-4-5-20251001".to_string(),
                    name: "Claude Haiku 4.5".to_string(),
                    api_variant: None,
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
                    })
                })
                .collect()
        }
        _ => {
            // OpenAI/OpenRouter return { "data": [{ "id": "...", "name": "..." }] }
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
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 32,
                "messages": [
                    { "role": "user", "content": "Reply with exactly: Connection OK" }
                ]
            });

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
    /// AI のべりすと: "legacy" | "v1"。FE から渡される API 経路。
    pub api_variant: Option<String>,
    /// Web 検索 (RAG) 設定。None または `enabled=false` なら検索を注入しない。
    pub web_search: Option<WebSearchConfig>,
}

fn supports_prompt_cache(provider: &AiProvider, model: &str) -> bool {
    matches!(provider, AiProvider::Anthropic)
        || (matches!(provider, AiProvider::OpenRouter) && model.contains("claude"))
}

/// Build Anthropic/OpenRouter-Claude system payload with optional cache markers.
fn build_system_payload(
    provider: &AiProvider,
    model: &str,
    fallback: &str,
    cache_segments: Option<&[String]>,
) -> serde_json::Value {
    if let Some(segments) = cache_segments {
        if supports_prompt_cache(provider, model) {
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
            if !blocks.is_empty() {
                // AUDIT POINT: Chat cache_control at L1/L2/L3/L4 boundaries (4 segments max).
                return serde_json::Value::Array(blocks);
            }
        }
        let joined = segments.join("\n");
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
) -> Vec<serde_json::Value> {
    let cache_blocks = if supports_prompt_cache(provider, model) {
        cache_segments.and_then(openai_system_cache_blocks)
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
async fn send_with_429_retry(
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
fn apply_openrouter_provider_pin(
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

/// `params.extra_body` をリクエストボディにマージする。
/// `body` がオブジェクトでない場合は何もしない。
fn merge_extra_body(body: &mut serde_json::Value, extra: &Option<serde_json::Value>) {
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
pub async fn send_chat(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();

    // AI のべりすと legacy は独自フォーマット。v1 は OpenAI 互換分岐へ合流。
    if matches!(params.provider, AiProvider::AiNovelist) && !is_ainoverist_v1(params) {
        return send_chat_ainoverist(&client, params, messages).await;
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
            );
            if !system_content.is_empty() || params.system_cache_segments.is_some() {
                body["system"] = system_payload;
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_request(&client, params, &body)
                .send()
                .await?
                .error_for_status()?;
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
            );

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": openai_max_tokens(params),
                "messages": chat_messages,
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );

            let req = openai_compat_request(&client, params, &body);
            let resp = send_with_429_retry(req, params.retry_429, 3)
                .await?
                .error_for_status()?;
            let result: serde_json::Value = resp.json().await?;
            parse_openai_response(&result)
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
fn push_unique_citation(citations: &mut Vec<Citation>, cit: Citation) {
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

fn parse_openai_response(result: &serde_json::Value) -> anyhow::Result<ChatResponse> {
    let choice = &result["choices"][0];
    let finish_reason = choice["finish_reason"].as_str().unwrap_or("stop");
    let stop_reason = if finish_reason == "tool_calls" {
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

    // OpenRouter: message.reasoning_content フィールド
    if let Some(reasoning) = message["reasoning_content"].as_str() {
        if !reasoning.is_empty() {
            blocks.push(ResponseBlock::Thinking {
                content: reasoning.to_string(),
                summary: None,
                signature: None,
            });
        }
    }

    if let Some(content) = message["content"].as_str() {
        if !content.is_empty() {
            blocks.push(ResponseBlock::Text {
                content: content.to_string(),
            });
        }
    }

    if let Some(tool_calls) = message["tool_calls"].as_array() {
        for tc in tool_calls {
            let id = tc["id"].as_str().unwrap_or("").to_string();
            let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
            let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
            let input: serde_json::Value = serde_json::from_str(args_str)
                .unwrap_or(serde_json::Value::Object(Default::default()));
            blocks.push(ResponseBlock::ToolUse { id, name, input });
        }
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

/// Ollama / OpenRouter / AI のべりすと v1 向け reasoning パラメータを適用する。
fn apply_reasoning_to_body(
    body: &mut serde_json::Value,
    provider: &AiProvider,
    api_variant: Option<&str>,
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
            let mut thinking_obj = serde_json::json!({
                "type": "adaptive",
                "effort": t_effort
            });
            if let Some(d) = display {
                thinking_obj["display"] = serde_json::Value::String(d.clone());
            }
            body["thinking"] = thinking_obj;
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
                body["effort"] = serde_json::Value::String(e.clone());
            }
        }
        None => {
            if let Some(e) = effort {
                body["effort"] = serde_json::Value::String(e.clone());
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

/// Build a POST request to Anthropic's `/messages` endpoint with required
/// headers (`x-api-key`, `anthropic-version`, `content-type`) and the
/// `anthropic-beta: interleaved-thinking-2025-05-14` header when
/// `params.thinking` is set, then attach `body` as JSON.
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
    if params.thinking.is_some() {
        req = req.header("anthropic-beta", "interleaved-thinking-2025-05-14");
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
                );
            }
            // thinking / effort パラメータを追加
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_request(&client, params, &body)
                .send()
                .await?
                .error_for_status()?;
            let result: serde_json::Value = resp.json().await?;
            parse_anthropic_response(&result)
        }
        _ => {
            // OpenAI-compatible format (OpenAI, OpenRouter, Ollama)。
            // OpenRouter + Claude では system に cache_control を載せて prompt cache を効かせる
            // (チャット経路と同じ手法)。最初の system 1 つにのみ適用 (4 breakpoint 超過=400 を防ぐ)。
            let system_cache_blocks = if supports_prompt_cache(params.provider, params.model) {
                params
                    .system_cache_segments
                    .as_deref()
                    .and_then(openai_system_cache_blocks)
            } else {
                None
            };
            let mut system_cache_applied = false;
            let mut openai_messages: Vec<serde_json::Value> = Vec::new();
            for msg in messages {
                match msg {
                    AgentMessage::User { content } => {
                        openai_messages
                            .push(serde_json::json!({ "role": "user", "content": content }));
                    }
                    AgentMessage::System { content } => {
                        let blocks = if system_cache_applied {
                            None
                        } else {
                            system_cache_blocks.as_ref()
                        };
                        if let Some(blocks) = blocks {
                            system_cache_applied = true;
                            openai_messages
                                .push(serde_json::json!({ "role": "system", "content": blocks }));
                        } else {
                            openai_messages
                                .push(serde_json::json!({ "role": "system", "content": content }));
                        }
                    }
                    AgentMessage::Assistant {
                        content, tool_uses, ..
                    } => {
                        if tool_uses.is_empty() {
                            openai_messages.push(
                                serde_json::json!({ "role": "assistant", "content": content }),
                            );
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
                            openai_messages.push(serde_json::json!({
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
                        openai_messages.push(serde_json::json!({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": content
                        }));
                    }
                }
            }

            // Build OpenAI tool definitions
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

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": openai_max_tokens(params),
                "messages": openai_messages,
                "tools": openai_tools
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );

            // RAG: OpenRouter のみ Web 検索を注入。Agent モードは server tool
            // (モデルが検索要否を判断)、非 Agent は web plugin (一発検索)。引用は
            // url_citation で統一。Phase 2: ドメイン制御 / content cap が指定された
            // ターンのみ engine=exa を強制し制御を載せる (それ以外は auto のまま)。
            if matches!(params.provider, AiProvider::OpenRouter) {
                if let Some(ws) = params.web_search.as_ref() {
                    if ws.enabled {
                        let force_exa = ws.needs_exa_engine();
                        if ws.agentic {
                            if let Some(arr) = body["tools"].as_array_mut() {
                                let mut tool =
                                    serde_json::json!({ "type": "openrouter:web_search" });
                                if force_exa {
                                    apply_openrouter_web_controls(&mut tool, ws);
                                }
                                arr.push(tool);
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
                }
            }

            let req = openai_compat_request(&client, params, &body);
            let resp = send_with_429_retry(req, params.retry_429, 3)
                .await?
                .error_for_status()?;
            let result: serde_json::Value = resp.json().await?;
            parse_openai_response(&result)
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

    // Build the user content array (content blocks).
    let mut user_blocks: Vec<serde_json::Value> = Vec::new();
    if let Some(codex) = codex_content {
        // Codex prefix — mark for caching so it is reused across chunk calls.
        // AUDIT POINT: cache_control must sit at the Codex/Scene boundary.
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

    match settings.provider {
        AiProvider::Anthropic => {
            let url = format!("{}/messages", settings.provider.base_url(endpoints));
            let body = serde_json::json!({
                "model": settings.model,
                "max_tokens": 4096,
                "system": system_prompt,
                "messages": [{ "role": "user", "content": user_blocks }]
            });
            let resp = client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "prompt-caching-2024-07-31")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;
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
            let url = format!(
                "{}/chat/completions",
                settings
                    .provider
                    .openai_compat_base_url(endpoints, api_variant.as_deref())
            );
            let mut body = serde_json::json!({
                "model": settings.model,
                "max_tokens": 4096,
                "messages": [
                    { "role": "system", "content": system_prompt },
                    { "role": "user",   "content": user_blocks }
                ]
            });
            apply_openrouter_provider_pin(
                &mut body,
                &settings.provider,
                settings.openrouter_provider_pin.as_deref(),
            );
            let mut req = client.post(url).header("content-type", "application/json");
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
            let resp = req.json(&body).send().await?.error_for_status()?;
            let result: serde_json::Value = resp.json().await?;
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
const MAX_SSE_BUFFER_BYTES: usize = 8 * 1024 * 1024; // 8 MiB

/// SSE イベント境界。仕様は「空行」だが、`\r\n\r\n` と `\n\n` の両方を扱う。
/// Windows 経由や一部プロキシでは CRLF のみになり `"\n\n"` 検出で永遠にバッファが進まないことがある。
#[inline]
fn find_sse_frame_separator(buf: &str) -> Option<(usize, usize)> {
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
        AiProvider::OpenAI | AiProvider::OpenaiCompatible => {
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
            );
            if !system_content.is_empty() || params.system_cache_segments.is_some() {
                body["system"] = system_payload;
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = anthropic_request(&client, params, &body).send().await?;
            if !resp.status().is_success() {
                let status = resp.status();
                let body_text = resp.text().await.unwrap_or_default();
                return Err(anyhow::anyhow!("HTTP {}: {}", status, body_text));
            }

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
            );

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": openai_max_tokens(params),
                "messages": chat_messages,
                "stream": true,
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.api_variant.as_deref(),
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );

            // N4: ストリーミングでも usage/cost を最終チャンクで受け取る。
            apply_stream_usage_optin(&mut body, params.provider);

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

                            // OpenRouter: reasoning_content フィールド
                            if let Some(reasoning) = delta["reasoning_content"].as_str() {
                                if !reasoning.is_empty() {
                                    let _ = app_handle.emit(
                                        &chunk_event,
                                        serde_json::json!({
                                            "delta": reasoning,
                                            "block_type": "thinking"
                                        }),
                                    );
                                }
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
        );
        assert!(
            out[0]["content"].is_array(),
            "system content should be blocks"
        );
        assert_eq!(out[0]["content"][0]["text"], "L1");
        assert_eq!(out[0]["content"][0]["cache_control"]["type"], "ephemeral");
        assert_eq!(out[0]["content"][1]["text"], "L2");
        assert_eq!(out[0]["content"][1]["cache_control"]["type"], "ephemeral");
        // user は plain string のまま。
        assert_eq!(out[1]["content"], "hi");
        assert_eq!(out[1]["role"], "user");
    }

    #[test]
    fn build_openai_chat_messages_plain_when_not_claude_or_no_segments() {
        let msgs = [("system", "S"), ("user", "hi")];
        let segs = vec!["L1".to_string()];
        // 非 Claude モデル → cache_control 無し。
        let out = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "openai/gpt-5.5",
            Some(&segs),
        );
        assert_eq!(out[0]["content"], "S");
        // Claude だが segments 無し → plain。
        let out2 = build_openai_chat_messages(
            &msgs,
            &AiProvider::OpenRouter,
            "anthropic/claude-4.6-sonnet",
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
            ai_novelist: AiNovelistSettings::default(),
            cli: None,
            openrouter_provider_pin: None,
            model_api_variant: None,
        };

        write_ai_settings(&path, &settings).expect("write");
        let loaded = read_ai_settings(&path);

        assert_eq!(loaded.provider, AiProvider::OpenAI);
        assert_eq!(loaded.model, "gpt-4o");

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
            Some(true),
            &Some("high".to_string()),
        );
        assert!(body.as_object().unwrap().is_empty());
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
        let resp = parse_openai_response(&json).unwrap();
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
        let resp = parse_openai_response(&json).unwrap();
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
}
