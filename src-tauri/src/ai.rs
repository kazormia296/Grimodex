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
/// - `AiNovelist` は AI のべりすと専用プロバイダ。独自 API フォーマット
///   (text / length / data ラッパ) を使い、OpenAI 互換エンドポイントを持たない。
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
            AiProvider::AiNovelist => String::new(), // 静的リストを返すため不要
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
    // 静的リストを持つプロバイダは HTTP を叩かずに返す
    match provider {
        AiProvider::Anthropic => {
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
        AiProvider::AiNovelist => {
            return Ok(vec![
                AiModel {
                    id: "derrida_03".to_string(),
                    name: "derrida_03".to_string(),
                },
                AiModel {
                    id: "spiko".to_string(),
                    name: "spiko".to_string(),
                },
                AiModel {
                    id: "spiko_solid".to_string(),
                    name: "spiko_solid".to_string(),
                },
                AiModel {
                    id: "spiko_max".to_string(),
                    name: "spiko_max".to_string(),
                },
                AiModel {
                    id: "damsel_ray".to_string(),
                    name: "damsel_ray".to_string(),
                },
                AiModel {
                    id: "supertrin_highpres".to_string(),
                    name: "supertrin_highpres".to_string(),
                },
                AiModel {
                    id: "supertrin_maxpres".to_string(),
                    name: "supertrin_maxpres".to_string(),
                },
                AiModel {
                    id: "supertrin".to_string(),
                    name: "supertrin (legacy)".to_string(),
                },
                AiModel {
                    id: "damsel".to_string(),
                    name: "damsel (legacy)".to_string(),
                },
            ]);
        }
        _ => {}
    }

    let url = provider.models_url(endpoints);
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

    // AI のべりすと: 独自エンドポイント (POST <base>) + text / length フィールド
    if matches!(provider, AiProvider::AiNovelist) {
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

    // AI のべりすとは独自フォーマットなので OpenAI 互換パスから外して専用関数に流す
    if matches!(params.provider, AiProvider::AiNovelist) {
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
/// AiNovelist はこの関数を経由しない (独自エンドポイントを使用)。
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

    // AI のべりすとは tool use を持たない (Phase A.2 では capabilitiesOverride で
    // supportsTools=false 固定だが、Agent mode から誤って呼ばれた場合の防御)
    if matches!(params.provider, AiProvider::AiNovelist) {
        return Err(anyhow::anyhow!(
            "AI のべりすとは Tool Use に対応していません"
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
            let url = format!(
                "{}/chat/completions",
                settings.provider.openai_compat_base_url(endpoints)
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
                    .header(
                        "HTTP-Referer",
                        "https://github.com/futurebassisdead/Grimodex",
                    )
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

    // AI のべりすと: ストリーミング非対応なので非ストリーム版を呼んで結果を一括 emit
    if matches!(params.provider, AiProvider::AiNovelist) {
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
            apply_openrouter_provider_pin(
                &mut body,
                params.provider,
                params.openrouter_provider_pin,
            );

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
        assert_eq!(AiProvider::AiNovelist.models_url(ep), "");
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
}
