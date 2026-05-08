use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

use crate::openai_compat_presets;

/// Supported AI providers.
///
/// - `OpenaiCompatible` はユーザーが任意の OpenAI 互換エンドポイント
///   (llama.cpp / LM Studio / vLLM / 自前ホスト等) を `baseURL` で指定する
///   プロバイダ。`AiSettings.openai_compatible.base_url` を参照する。
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
            AiProvider::Cli => String::new(),
        }
    }

    /// OpenAI-compatible base URL (used for chat/completions).
    /// Ollama exposes the OpenAI-compatible API at /v1, not /api.
    pub fn openai_compat_base_url(&self, ep: ProviderEndpoints<'_>) -> String {
        match self {
            AiProvider::Ollama => format!("{}/v1", ep.ollama.trim_end_matches('/')),
            _ => self.base_url(ep),
        }
    }

    /// Models endpoint URL.
    pub fn models_url(&self, ep: ProviderEndpoints<'_>) -> String {
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
            AiProvider::Cli => write!(f, "cli"),
        }
    }
}

fn default_thinking_enabled() -> bool {
    true
}

/// OpenAI 互換プロバイダ用の設定。プリセット ID と任意のユーザー入力を保持する。
/// - `preset = "custom"`: ユーザーが `base_url` を入力する
/// - `preset = "ainoverist"`: プリセット側で固定 URL を提供
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenaiCompatibleSettings {
    /// プリセット ID。デフォルトは "custom"
    #[serde(default = "default_openai_compat_preset")]
    pub preset: String,
    /// custom プリセット時にユーザーが入力する OpenAI 互換エンドポイント
    #[serde(default)]
    pub base_url: String,
    /// custom プリセット時に手動指定するモデルのコンテキスト窓
    #[serde(default)]
    pub custom_max_context: Option<u32>,
    /// custom プリセット時に手動指定するモデルの最大出力
    #[serde(default)]
    pub custom_max_output: Option<u32>,
    /// プリセット側 `extra_sampling_keys` で許可されているサンプリングパラメータ。
    /// AI のべりすとの top_a / tailfree / typical_p / min_p / rep_pen /
    /// badwords / stoptokens / logit_bias など。リクエストボディに素通しされる。
    #[serde(default)]
    pub sampling: Option<serde_json::Value>,
    /// AI Codex 自動抽出 / Synopsis / セッションタイトル自動生成タスクで
    /// このプロバイダを使うかどうか。プリセットの defaultDisableStructuredTasks=true
    /// の場合、デフォルト false（オプトイン式）。
    #[serde(default)]
    pub enable_structured_tasks: Option<bool>,
}

fn default_openai_compat_preset() -> String {
    "custom".to_string()
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
    pub cli: Option<CliSettings>,
}

impl AiSettings {
    /// 現在の設定からプロバイダ別エンドポイントを構築する。
    /// OpenaiCompatible + ainoverist 等の固定 URL を持つプリセットの場合、
    /// プリセット側 URL を優先する。
    pub fn endpoints(&self) -> ProviderEndpoints<'_> {
        let openai_compat_custom =
            match openai_compat_presets::fixed_base_url(&self.openai_compatible.preset) {
                Some(fixed) => fixed,
                None => self.openai_compatible.base_url.as_str(),
            };
        ProviderEndpoints {
            ollama: &self.ollama_endpoint,
            openai_compat_custom,
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
            cli: None,
        }
    }
}

/// Model entry returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModel {
    pub id: String,
    pub name: String,
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
    let url = provider.models_url(endpoints);
    if url.is_empty() {
        // Anthropic: return a static list
        return Ok(vec![
            AiModel {
                id: "claude-sonnet-4-6".to_string(),
                name: "Claude Sonnet 4.6".to_string(),
            },
            AiModel {
                id: "claude-haiku-4-5-20251001".to_string(),
                name: "Claude Haiku 4.5".to_string(),
            },
        ]);
    }

    let client = reqwest::Client::new();
    let mut req = client.get(&url);

    match provider {
        AiProvider::Ollama => {} // No auth needed
        AiProvider::OpenRouter => {
            req = req
                .header("Authorization", format!("Bearer {api_key}"))
                .header(
                    "HTTP-Referer",
                    "https://github.com/futurebassisdead/Grimodex",
                )
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
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();

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
                provider.openai_compat_base_url(endpoints)
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
            // OpenAI-compatible format (OpenRouter, OpenAI, OpenaiCompatible)
            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(endpoints)
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
                    .header(
                        "HTTP-Referer",
                        "https://github.com/futurebassisdead/Grimodex",
                    )
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
    /// OpenAI 互換プロバイダのプリセット（ainoverist 等）が要求する追加リクエスト
    /// ボディフィールド。`top_a` / `tailfree` 等の独自サンプリングパラメータを
    /// オブジェクトで渡すと、`send_chat*` がリクエストボディにマージする。
    pub extra_body: Option<serde_json::Value>,
    /// 429 (Too Many Requests) を受けたときに指数バックオフでリトライするか。
    /// レート制限を公開しているプリセット（ainoverist 等）で true にする。
    pub retry_429: bool,
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

    match params.provider {
        AiProvider::Anthropic => {
            let (system_content, chat_messages) = split_system_messages(messages);

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
            });
            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
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
            let chat_messages: Vec<serde_json::Value> = messages
                .iter()
                .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
                .collect();

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);

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

/// Structured response returned from `send_chat_with_tools`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatResponse {
    pub blocks: Vec<ResponseBlock>,
    pub stop_reason: String,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

fn parse_anthropic_response(result: &serde_json::Value) -> anyhow::Result<ChatResponse> {
    let stop_reason = result["stop_reason"]
        .as_str()
        .unwrap_or("end_turn")
        .to_string();
    let mut blocks = Vec::new();

    if let Some(content) = result["content"].as_array() {
        for block in content {
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or("").to_string();
                    if !text.is_empty() {
                        blocks.push(ResponseBlock::Text { content: text });
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

    let input_tokens = result["usage"]["prompt_tokens"].as_u64();
    let output_tokens = result["usage"]["completion_tokens"].as_u64();

    Ok(ChatResponse {
        blocks,
        stop_reason,
        input_tokens,
        output_tokens,
    })
}

/// Ollama/OpenRouter 向け reasoning パラメータをリクエストボディに適用する。
fn apply_reasoning_to_body(
    body: &mut serde_json::Value,
    provider: &AiProvider,
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
/// (OpenAI / OpenRouter / Ollama / OpenaiCompatible). Adds `Authorization: Bearer ...`
/// for providers that require it (skips Ollama, and skips OpenaiCompatible when
/// the API key is empty for keyless local LLM servers), and OpenRouter's
/// attribution headers, then attaches `body` as JSON.
fn openai_compat_request(
    client: &reqwest::Client,
    params: &ChatParams<'_>,
    body: &serde_json::Value,
) -> reqwest::RequestBuilder {
    let url = format!(
        "{}/chat/completions",
        params.provider.openai_compat_base_url(params.endpoints)
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
            .header(
                "HTTP-Referer",
                "https://github.com/futurebassisdead/Grimodex",
            )
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
pub async fn send_chat_with_tools(
    params: &ChatParams<'_>,
    messages: &[AgentMessage],
    tools: &[AgentToolDef],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();

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

            // Build Anthropic tool definitions
            let anthropic_tools: Vec<serde_json::Value> = tools
                .iter()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema
                    })
                })
                .collect();

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": anthropic_messages,
                "tools": anthropic_tools
            });
            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
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
            // OpenAI-compatible format (OpenAI, OpenRouter, Ollama)
            let mut openai_messages: Vec<serde_json::Value> = Vec::new();
            for msg in messages {
                match msg {
                    AgentMessage::User { content } => {
                        openai_messages
                            .push(serde_json::json!({ "role": "user", "content": content }));
                    }
                    AgentMessage::System { content } => {
                        openai_messages
                            .push(serde_json::json!({ "role": "system", "content": content }));
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
                "max_tokens": 4096,
                "messages": openai_messages,
                "tools": openai_tools
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);

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
// G1: Streaming chat
// ---------------------------------------------------------------------------

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

    match params.provider {
        AiProvider::Anthropic => {
            let (system_content, chat_messages) = split_system_messages(messages);

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
                "stream": true,
            });
            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
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

            while let Some(chunk) = stream.next().await {
                if abort_flag.load(Ordering::Relaxed) {
                    stop_reason = "stopped".to_string();
                    break;
                }
                let bytes = chunk.map_err(|e| anyhow::anyhow!("stream error: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                // Process complete SSE messages separated by \n\n
                while let Some(pos) = buf.find("\n\n") {
                    let chunk_str = buf[..pos].to_string();
                    buf.drain(..pos + 2);

                    for line in chunk_str.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
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
                                    if let Some(inp) =
                                        json["message"]["usage"]["input_tokens"].as_u64()
                                    {
                                        input_tokens = Some(inp);
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
                }),
            );
            Ok(())
        }
        _ => {
            // OpenAI-compatible format (OpenAI, OpenRouter, Ollama)
            let chat_messages: Vec<serde_json::Value> = messages
                .iter()
                .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
                .collect();

            let mut body = serde_json::json!({
                "model": params.model,
                "max_tokens": 4096,
                "messages": chat_messages,
                "stream": true,
            });
            apply_reasoning_to_body(
                &mut body,
                params.provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );
            merge_extra_body(&mut body, &params.extra_body);

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

            while let Some(chunk) = stream.next().await {
                if abort_flag.load(Ordering::Relaxed) {
                    stop_reason = "stopped".to_string();
                    break;
                }
                let bytes = chunk.map_err(|e| anyhow::anyhow!("stream error: {e}"))?;
                buf.push_str(&String::from_utf8_lossy(&bytes));

                while let Some(pos) = buf.find("\n\n") {
                    let chunk_str = buf[..pos].to_string();
                    buf.drain(..pos + 2);

                    for line in chunk_str.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
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

                            if let Some(content) = delta["content"].as_str() {
                                if !content.is_empty() {
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
            }

            let _ = app_handle.emit(
                &done_event,
                serde_json::json!({
                    "stop_reason": stop_reason,
                    "input_tokens": input_tokens,
                    "output_tokens": output_tokens,
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
            cli: None,
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
            AiProvider::Ollama.openai_compat_base_url(ep),
            "http://localhost:11434/v1"
        );
        // Other providers unchanged
        assert_eq!(
            AiProvider::OpenRouter.openai_compat_base_url(ep),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            AiProvider::OpenAI.openai_compat_base_url(ep),
            "https://api.openai.com/v1"
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
            AiProvider::OpenaiCompatible.openai_compat_base_url(ep),
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
            AiProvider::OpenaiCompatible.models_url(ep),
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
    }

    #[test]
    fn test_provider_serde_roundtrip() {
        let json = serde_json::to_string(&AiProvider::OpenRouter).expect("serialize");
        assert_eq!(json, "\"openrouter\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::OpenRouter);

        // OpenaiCompatible uses kebab-case
        let json = serde_json::to_string(&AiProvider::OpenaiCompatible).expect("serialize");
        assert_eq!(json, "\"openai-compatible\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::OpenaiCompatible);
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
}
