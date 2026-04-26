use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::{atomic::Ordering, Arc};

/// Supported AI providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    OpenRouter,
    OpenAI,
    Anthropic,
    Ollama,
}

impl AiProvider {
    /// Keyring service name for this provider.
    fn keyring_service(&self) -> &str {
        match self {
            AiProvider::OpenRouter => "grimodex-openrouter",
            AiProvider::OpenAI => "grimodex-openai",
            AiProvider::Anthropic => "grimodex-anthropic",
            AiProvider::Ollama => "grimodex-ollama",
        }
    }

    /// Base URL for API requests.
    pub fn base_url(&self, ollama_endpoint: &str) -> String {
        match self {
            AiProvider::OpenRouter => "https://openrouter.ai/api/v1".to_string(),
            AiProvider::OpenAI => "https://api.openai.com/v1".to_string(),
            AiProvider::Anthropic => "https://api.anthropic.com/v1".to_string(),
            AiProvider::Ollama => format!("{}/api", ollama_endpoint.trim_end_matches('/')),
        }
    }

    /// OpenAI-compatible base URL (used for chat/completions).
    /// Ollama exposes the OpenAI-compatible API at /v1, not /api.
    pub fn openai_compat_base_url(&self, ollama_endpoint: &str) -> String {
        match self {
            AiProvider::Ollama => format!("{}/v1", ollama_endpoint.trim_end_matches('/')),
            _ => self.base_url(ollama_endpoint),
        }
    }

    /// Models endpoint URL.
    pub fn models_url(&self, ollama_endpoint: &str) -> String {
        match self {
            AiProvider::OpenRouter => "https://openrouter.ai/api/v1/models".to_string(),
            AiProvider::OpenAI => "https://api.openai.com/v1/models".to_string(),
            AiProvider::Anthropic => {
                // Anthropic doesn't have a list models endpoint; return empty
                String::new()
            }
            AiProvider::Ollama => {
                format!("{}/api/tags", ollama_endpoint.trim_end_matches('/'))
            }
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
        }
    }
}

fn default_thinking_enabled() -> bool {
    true
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
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            provider: AiProvider::OpenRouter,
            model: String::new(),
            ollama_endpoint: "http://localhost:11434".to_string(),
            thinking_enabled: true,
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
    ollama_endpoint: &str,
) -> anyhow::Result<Vec<AiModel>> {
    let url = provider.models_url(ollama_endpoint);
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
    ollama_endpoint: &str,
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();

    match provider {
        AiProvider::Anthropic => {
            // Anthropic uses a different API format
            let url = format!("{}/messages", provider.base_url(ollama_endpoint));
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
                provider.openai_compat_base_url(ollama_endpoint)
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
            // OpenAI-compatible format (OpenRouter, OpenAI)
            let url = format!("{}/chat/completions", provider.base_url(ollama_endpoint));
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 32,
                "messages": [
                    { "role": "user", "content": "Reply with exactly: Connection OK" }
                ]
            });

            let mut req = client
                .post(&url)
                .header("Authorization", format!("Bearer {api_key}"))
                .header("content-type", "application/json");

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
    pub ollama_endpoint: &'a str,
    pub thinking: Option<ThinkingConfig>,
    pub effort: Option<String>,
    pub reasoning_enabled: Option<bool>,
    pub reasoning_effort: Option<String>,
}

/// Send a chat completion request with the given messages.
/// Messages are tuples of (role, content). Supports "system", "user", "assistant" roles.
pub async fn send_chat(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
) -> anyhow::Result<ChatResponse> {
    let provider = params.provider;
    let model = params.model;
    let api_key = params.api_key;
    let ollama_endpoint = params.ollama_endpoint;
    let client = reqwest::Client::new();

    match provider {
        AiProvider::Anthropic => {
            // Anthropic: system is a top-level field, not in messages
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

            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "messages": chat_messages,
            });

            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let resp = client
                .post(format!("{}/messages", provider.base_url(ollama_endpoint)))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await?
                .error_for_status()?;

            let result: serde_json::Value = resp.json().await?;
            parse_anthropic_response(&result)
        }
        _ => {
            // OpenAI-compatible format (OpenRouter, OpenAI, Ollama)
            let chat_messages: Vec<serde_json::Value> = messages
                .iter()
                .map(|(role, content)| serde_json::json!({ "role": role, "content": content }))
                .collect();

            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "messages": chat_messages,
            });

            apply_reasoning_to_body(
                &mut body,
                provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );

            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(ollama_endpoint)
            );

            let mut req = client.post(&url).header("content-type", "application/json");

            if !matches!(provider, AiProvider::Ollama) {
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

/// Send a tool-aware chat request and return a structured response.
pub async fn send_chat_with_tools(
    params: &ChatParams<'_>,
    messages: &[AgentMessage],
    tools: &[AgentToolDef],
) -> anyhow::Result<ChatResponse> {
    let provider = params.provider;
    let model = params.model;
    let api_key = params.api_key;
    let ollama_endpoint = params.ollama_endpoint;
    let client = reqwest::Client::new();

    match provider {
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
                "model": model,
                "max_tokens": 4096,
                "messages": anthropic_messages,
                "tools": anthropic_tools
            });
            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
            }
            // thinking / effort パラメータを追加
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let mut req = client
                .post(format!("{}/messages", provider.base_url(ollama_endpoint)))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json");
            // interleaved thinking 用ベータヘッダー
            if params.thinking.is_some() {
                req = req.header("anthropic-beta", "interleaved-thinking-2025-05-14");
            }
            let resp = req.json(&body).send().await?.error_for_status()?;

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
                "model": model,
                "max_tokens": 4096,
                "messages": openai_messages,
                "tools": openai_tools
            });

            apply_reasoning_to_body(
                &mut body,
                provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );

            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(ollama_endpoint)
            );
            let mut req = client.post(&url).header("content-type", "application/json");

            if !matches!(provider, AiProvider::Ollama) {
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
    let provider = params.provider;
    let model = params.model;
    let api_key = params.api_key;
    let ollama_endpoint = params.ollama_endpoint;
    use tauri::Emitter;

    let chunk_event = format!("{}:stream-chunk", event_prefix);
    let done_event = format!("{}:stream-done", event_prefix);

    let client = reqwest::Client::new();

    match provider {
        AiProvider::Anthropic => {
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

            let mut body = serde_json::json!({
                "model": model,
                "max_tokens": 4096,
                "messages": chat_messages,
                "stream": true,
            });

            if !system_content.is_empty() {
                body["system"] = serde_json::Value::String(system_content);
            }
            apply_thinking_to_body(&mut body, &params.thinking, &params.effort);

            let mut req = client
                .post(format!("{}/messages", provider.base_url(ollama_endpoint)))
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .header("content-type", "application/json");
            if params.thinking.is_some() {
                req = req.header("anthropic-beta", "interleaved-thinking-2025-05-14");
            }

            let resp = req.json(&body).send().await?;
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
                "model": model,
                "max_tokens": 4096,
                "messages": chat_messages,
                "stream": true,
            });

            apply_reasoning_to_body(
                &mut body,
                provider,
                params.reasoning_enabled,
                &params.reasoning_effort,
            );

            let url = format!(
                "{}/chat/completions",
                provider.openai_compat_base_url(ollama_endpoint)
            );

            let mut req = client.post(&url).header("content-type", "application/json");

            if !matches!(provider, AiProvider::Ollama) {
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

            let resp = req.json(&body).send().await?;
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
        let endpoint = "http://localhost:11434";
        assert_eq!(
            AiProvider::OpenRouter.base_url(endpoint),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            AiProvider::OpenAI.base_url(endpoint),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            AiProvider::Anthropic.base_url(endpoint),
            "https://api.anthropic.com/v1"
        );
        assert_eq!(
            AiProvider::Ollama.base_url(endpoint),
            "http://localhost:11434/api"
        );
    }

    #[test]
    fn test_provider_openai_compat_base_url() {
        let endpoint = "http://localhost:11434";
        // Ollama uses /v1 for OpenAI-compatible endpoints
        assert_eq!(
            AiProvider::Ollama.openai_compat_base_url(endpoint),
            "http://localhost:11434/v1"
        );
        // Other providers unchanged
        assert_eq!(
            AiProvider::OpenRouter.openai_compat_base_url(endpoint),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            AiProvider::OpenAI.openai_compat_base_url(endpoint),
            "https://api.openai.com/v1"
        );
    }

    #[test]
    fn test_provider_display() {
        assert_eq!(AiProvider::OpenRouter.to_string(), "openrouter");
        assert_eq!(AiProvider::OpenAI.to_string(), "openai");
        assert_eq!(AiProvider::Anthropic.to_string(), "anthropic");
        assert_eq!(AiProvider::Ollama.to_string(), "ollama");
    }

    #[test]
    fn test_provider_serde_roundtrip() {
        let json = serde_json::to_string(&AiProvider::OpenRouter).expect("serialize");
        assert_eq!(json, "\"openrouter\"");
        let parsed: AiProvider = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, AiProvider::OpenRouter);
    }

    #[test]
    fn test_ollama_endpoint_trailing_slash() {
        assert_eq!(
            AiProvider::Ollama.base_url("http://localhost:11434/"),
            "http://localhost:11434/api"
        );
    }
}
