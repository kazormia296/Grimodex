//! OpenAI **Responses API** (`POST /v1/responses`) 対応。
//!
//! 既定の OpenAI 系経路は `/chat/completions` (ai.rs) を使うが、`api_variant ==
//! "responses"` かつ provider が `OpenAI` / `OpenaiCompatible` のとき、本モジュールが
//! `/responses` 形式でリクエスト/レスポンスを処理する。`ai_novelist.rs` がレガシー
//! 独自フォーマットを切り出しているのと同じく、別フォーマットをここに閉じ込めて
//! ai.rs 側の分岐を最小化する。
//!
//! Chat Completions との主な差分:
//! - body: `messages[]` → `input[]`（メッセージ + `function_call` / `function_call_output`
//!   アイテム）。system は `instructions` トップレベルへ。
//! - tools: `{type:function, function:{...}}` のネストではなく `{type:function, name,
//!   description, parameters}` のフラット形。
//! - 上限: `max_tokens` / `max_completion_tokens` → `max_output_tokens`。
//! - reasoning: `reasoning_effort` 文字列 → `reasoning:{effort, summary}` オブジェクト
//!   （summary を出すと streaming で reasoning 要約 delta が届く）。
//! - レスポンス: `choices[0].message` → `output[]`（`reasoning` / `message` /
//!   `function_call` アイテム列）。usage は `input_tokens` / `output_tokens`。
//! - streaming: OpenAI delta 形式ではなく型付き SSE イベント
//!   (`response.output_text.delta` / `response.reasoning_summary_text.delta` /
//!   `response.completed` …)。
//!
//! 推論モデル(o系/gpt-5系)×ツールのマルチターン: `store:false` の推論モデルは
//! 「function_call の直前に対応する reasoning アイテムが必須」(無いと HTTP 400)。
//! 毎ターン全 input を再送する stateless 運用のため、`include:["reasoning.encrypted_content"]`
//! で reasoning の暗号化状態を受け取り、`signature` に {id, encrypted_content} を載せて
//! 既存の thinking_blocks round-trip 経由で次ターンの input に reasoning アイテムとして
//! echo する(build_agent_input / parse_output)。これにより Chat Completions と違い
//! reasoning echo が必須な Responses でもツールエージェントが継続できる。

use crate::ai::{
    AgentMessage, AgentToolDef, AiProvider, AiSettings, ChatParams, ChatResponse, Citation,
    ProviderEndpoints, ResponseBlock, HERMES_BLOCKED_TOOL_NAMES,
};
use serde_json::{json, Value};
use std::sync::{atomic::Ordering, Arc};

/// この provider + api_variant の組で Responses API を使うべきか。
/// `/responses` を持つのは OpenAI 直叩き、それを公開する OpenAI 互換 gateway
/// (Azure OpenAI / LiteLLM 等)、および OpenRouter (beta `/api/v1/responses`)。
pub fn uses_responses_api(provider: &AiProvider, api_variant: Option<&str>) -> bool {
    api_variant == Some("responses")
        && matches!(
            provider,
            AiProvider::OpenAI | AiProvider::OpenaiCompatible | AiProvider::OpenRouter
        )
}

/// Responses は reasoning トークンも `max_output_tokens` に課金されるため、OpenAI 直は
/// 32k の余裕を持たせる(/chat/completions 経路の `openai_max_tokens` と同じ思想)。互換
/// gateway は reasoning が走るとき(明示 ON、または gpt-5.1+ で OFF=minimal を送る場合)も
/// 32k、それ以外は 4096(モデル上限超過 400 を避ける)。
fn max_output_tokens(provider: &AiProvider, model: &str, reasoning_enabled: Option<bool>) -> u32 {
    // apply_reasoning が何らか reasoning を付与する全ケースで予算を広げる。
    // (Some(false) でも gpt-5.1+ は minimal を送り、reasoning トークンを消費する)
    let reasoning_active = reasoning_enabled == Some(true)
        || (reasoning_enabled == Some(false)
            && crate::ai::openai_model_supports_reasoning_none(model))
        // OpenRouter 経由の reasoning モデル(gpt-5 / o系 / deepseek-r1 等)は hidden
        // reasoning も max_output_tokens に課金されるため、reasoning_enabled が未指定
        // でも名前で検出して予算を確保する(/chat/completions の openai_max_tokens と同根)。
        || (matches!(provider, AiProvider::OpenRouter)
            && crate::ai::is_openrouter_reasoning_model(model));
    if matches!(provider, AiProvider::OpenAI) || reasoning_active {
        32_000
    } else {
        4096
    }
}

// ---------------------------------------------------------------------------
// Request body builders (pure / testable)
// ---------------------------------------------------------------------------

/// `(role, content)` タプル列を Responses の `(instructions, input[])` に分解する。
/// system はすべて結合して `instructions` へ、その他は `{role, content}` メッセージへ。
pub fn build_chat_input(messages: &[(&str, &str)]) -> (String, Vec<Value>) {
    let instructions = messages
        .iter()
        .filter(|(role, _)| *role == "system")
        .map(|(_, content)| *content)
        .collect::<Vec<_>>()
        .join("\n");
    let input = messages
        .iter()
        .filter(|(role, _)| *role != "system")
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect();
    (instructions, input)
}

/// Agent メッセージ列を `(instructions, input[])` に変換する。
/// - System → instructions に結合
/// - User → `{role:user, content}`
/// - Assistant → 本文があれば `{role:assistant, content}`、tool_use は各 `function_call`
///   アイテムへ（本文 → function_call の順で並べる）
/// - ToolResult → `{type:function_call_output, call_id, output}`
///
/// `call_id` は parse 時に `output[].function_call.call_id` を `ToolUse.id` に写したもの
/// で、function_call と function_call_output のペアリングに使われる。
pub fn build_agent_input(messages: &[AgentMessage]) -> (String, Vec<Value>) {
    let mut instructions: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();
    for msg in messages {
        match msg {
            AgentMessage::System { content } => instructions.push(content.clone()),
            AgentMessage::User { content } => {
                input.push(json!({ "role": "user", "content": content }));
            }
            AgentMessage::Assistant {
                content,
                tool_uses,
                thinking_blocks,
            } => {
                // store:false の推論モデルでは function_call の直前に対応する
                // reasoning アイテムが必須。parse_output が signature に載せた
                // {id, ec} を復元して reasoning アイテムを先頭に echo する
                // (本文 → function_call より前に置く)。signature が当該 JSON 形で
                // ない(非推論 / Anthropic 由来)ものは黙ってスキップ。
                for tb in thinking_blocks {
                    let Ok(meta) = serde_json::from_str::<Value>(&tb.signature) else {
                        continue;
                    };
                    if let (Some(id), Some(ec)) = (meta["id"].as_str(), meta["ec"].as_str()) {
                        input.push(json!({
                            "type": "reasoning",
                            "id": id,
                            "encrypted_content": ec,
                            "summary": [],
                        }));
                    }
                }
                if !content.is_empty() {
                    input.push(json!({ "role": "assistant", "content": content }));
                }
                for tu in tool_uses {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": tu.id,
                        "name": tu.name,
                        "arguments": tu.input.to_string(),
                    }));
                }
            }
            AgentMessage::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": content,
                }));
            }
        }
    }
    (instructions.join("\n"), input)
}

/// Agent ツール定義を Responses のフラット function 形へ。名前順でソートし、prefix cache
/// が効きやすいよう決定的順序にする(Chat Completions の tools 構築と同じ方針)。
pub fn build_tools(tools: &[AgentToolDef]) -> Vec<Value> {
    let mut sorted: Vec<&AgentToolDef> = tools.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));
    sorted
        .iter()
        .map(|t| {
            json!({
                "type": "function",
                "name": t.name,
                "description": t.description,
                "parameters": t.input_schema,
            })
        })
        .collect()
}

/// model / instructions / input / (任意)tools から Responses リクエストの素体を作る。
/// `store:false`(小説本文を OpenAI 側に保持させない)。instructions は空なら付けない。
fn base_body(
    model: &str,
    instructions: &str,
    input: Vec<Value>,
    tools: Option<Vec<Value>>,
) -> Value {
    let mut body = json!({
        "model": model,
        "input": input,
        "store": false,
    });
    if !instructions.is_empty() {
        body["instructions"] = json!(instructions);
    }
    if let Some(tools) = tools {
        body["tools"] = json!(tools);
    }
    body
}

/// reasoning パラメータを Responses 形(`reasoning:{effort, summary}`)で適用する。
/// `summary:"auto"` を付けると streaming で推論要約 delta が届く。reasoning_enabled が
/// None(=非推論モデル / FE が未指定)のときは何も足さない(非推論モデルに reasoning を
/// 送ると 400 になるため)。
pub fn apply_reasoning(
    body: &mut Value,
    model: &str,
    reasoning_enabled: Option<bool>,
    reasoning_effort: &Option<String>,
) {
    match reasoning_enabled {
        Some(true) => {
            let effort = match reasoning_effort.as_deref() {
                // Responses は xhigh 非対応。max は high に丸める。
                Some("max") => "high",
                Some(e @ ("minimal" | "low" | "medium" | "high")) => e,
                _ => "medium",
            };
            // gpt-5-pro は high 固定(low/medium で 400)。
            let effort = if crate::ai::openai_model_requires_high_effort(model) {
                "high"
            } else {
                effort
            };
            body["reasoning"] = json!({ "effort": effort, "summary": "auto" });
        }
        // OFF: Responses に "none" は無いので、最小値 minimal をサポートするモデル
        // (gpt-5.1+)のみ minimal を送る。o3/gpt-5 等には何も送らない(無効化不可)。
        Some(false) if crate::ai::openai_model_supports_reasoning_none(model) => {
            body["reasoning"] = json!({ "effort": "minimal" });
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Response parsing (pure / testable)
// ---------------------------------------------------------------------------

/// `parse_output` の挙動オプション。
pub struct ParseResponsesOptions {
    /// 低信頼 provider(OpenAI 互換 gateway 等)では mutating ツールの呼び出しを破棄する
    /// (間接プロンプトインジェクション対策。Chat Completions 経路と対称)。
    pub block_mutating_on_native: bool,
}

/// Responses の非ストリーミングレスポンス(`output[]`)を共通 `ChatResponse` へ。
pub fn parse_output(result: &Value, opts: &ParseResponsesOptions) -> anyhow::Result<ChatResponse> {
    // エラーエンベロープ(HTTP 200 で error を返す互換 gateway 対策)。
    if let Some(err) = result
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
    {
        anyhow::bail!("Responses API error: {err}");
    }

    let mut blocks: Vec<ResponseBlock> = Vec::new();
    let mut citations: Vec<Citation> = Vec::new();
    let mut native_tool_uses = 0usize;
    let mut saw_function_call = false;

    if let Some(output) = result["output"].as_array() {
        for item in output {
            match item["type"].as_str() {
                Some("reasoning") => {
                    let mut text = String::new();
                    if let Some(summary) = item["summary"].as_array() {
                        for s in summary {
                            if let Some(t) = s["text"].as_str() {
                                // 各 summary_text パートは独立段落。区切り無しで連結
                                // すると地続きで読みにくいので空行を挟む。
                                if !text.is_empty() {
                                    text.push_str("\n\n");
                                }
                                text.push_str(t);
                            }
                        }
                    }
                    // ツール継続のため reasoning item を echo 可能にする。id +
                    // encrypted_content を signature(JSON)へ載せ、FE の thinking_blocks
                    // 経由で round-trip する(build_agent_input が復元)。
                    // encrypted_content が無い(include 未適用)なら echo 不可なので None。
                    let signature = match (item["id"].as_str(), item["encrypted_content"].as_str())
                    {
                        (Some(id), Some(ec)) if !ec.is_empty() => {
                            Some(json!({ "id": id, "ec": ec }).to_string())
                        }
                        _ => None,
                    };
                    if !text.is_empty() || signature.is_some() {
                        blocks.push(ResponseBlock::Thinking {
                            content: text,
                            summary: None,
                            signature,
                        });
                    }
                }
                Some("message") => {
                    if let Some(content) = item["content"].as_array() {
                        for part in content {
                            // 安全方針による拒否は output_text ではなく
                            // {type:refusal, refusal:"..."} で来る。取りこぼすと
                            // 本文も理由も無い無言の空ターンになるので Text 化する。
                            if part["type"].as_str() == Some("refusal") {
                                if let Some(r) = part["refusal"].as_str() {
                                    if !r.is_empty() {
                                        blocks.push(ResponseBlock::Text {
                                            content: r.to_string(),
                                        });
                                    }
                                }
                                continue;
                            }
                            if part["type"].as_str() != Some("output_text") {
                                continue;
                            }
                            if let Some(t) = part["text"].as_str() {
                                if !t.is_empty() {
                                    blocks.push(ResponseBlock::Text {
                                        content: t.to_string(),
                                    });
                                }
                            }
                            if let Some(anns) = part["annotations"].as_array() {
                                for ann in anns {
                                    if ann["type"].as_str() != Some("url_citation") {
                                        continue;
                                    }
                                    if let Some(url) = ann["url"].as_str() {
                                        crate::ai::push_unique_citation(
                                            &mut citations,
                                            Citation {
                                                url: url.to_string(),
                                                title: ann["title"]
                                                    .as_str()
                                                    .unwrap_or("")
                                                    .to_string(),
                                                cited_text: String::new(),
                                                snippet: None,
                                                published_date: None,
                                            },
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                Some("function_call") => {
                    saw_function_call = true;
                    let call_id = item["call_id"].as_str().unwrap_or("").to_string();
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    // 低信頼 provider では mutating ツールを silent drop(Chat 経路と対称)。
                    if opts.block_mutating_on_native
                        && HERMES_BLOCKED_TOOL_NAMES.contains(&name.as_str())
                    {
                        continue;
                    }
                    let args_str = item["arguments"].as_str().unwrap_or("{}");
                    let input: Value =
                        serde_json::from_str(args_str).unwrap_or(Value::Object(Default::default()));
                    blocks.push(ResponseBlock::ToolUse {
                        id: call_id,
                        name,
                        input,
                    });
                    native_tool_uses += 1;
                }
                _ => {}
            }
        }
    }

    // status==incomplete は max_output_tokens / content_filter いずれも「正常終了で
    // ない打ち切り」なので length 扱い(空応答を黙って end_turn にしない)。
    let status = result["status"].as_str().unwrap_or("completed");
    let incomplete = status == "incomplete";

    // ツール呼び出しが(drop 後も)残れば tool_use。全て drop されたら通常終了に戻す。
    let stop_reason = if native_tool_uses > 0 {
        "tool_use"
    } else if saw_function_call {
        // 全 function_call が mutating で drop された → 通常終了扱い。
        "end_turn"
    } else if incomplete {
        "length"
    } else {
        "end_turn"
    }
    .to_string();

    let input_tokens = result["usage"]["input_tokens"].as_u64();
    let output_tokens = result["usage"]["output_tokens"].as_u64();

    Ok(ChatResponse {
        blocks,
        stop_reason,
        input_tokens,
        output_tokens,
        citations,
        cost: None,
    })
}

/// 非ストリーミング/単発の最初の出力テキストを取り出す(校閲 post-effect 用)。
/// `output_text`(集約フィールド、互換 gateway では欠落しうる) → `output[].message.
/// output_text` の順で探す。
fn extract_first_output_text(result: &Value) -> anyhow::Result<String> {
    if let Some(s) = result["output_text"].as_str() {
        if !s.is_empty() {
            return Ok(s.to_string());
        }
    }
    if let Some(output) = result["output"].as_array() {
        for item in output {
            if item["type"].as_str() != Some("message") {
                continue;
            }
            if let Some(content) = item["content"].as_array() {
                for part in content {
                    if part["type"].as_str() == Some("output_text") {
                        if let Some(t) = part["text"].as_str() {
                            return Ok(t.to_string());
                        }
                    }
                    // 安全方針の拒否は明示エラーで返す(無言の空応答にしない)。
                    if part["type"].as_str() == Some("refusal") {
                        if let Some(r) = part["refusal"].as_str() {
                            anyhow::bail!("Responses API refusal: {r}");
                        }
                    }
                }
            }
        }
    }
    // 打ち切り(reasoning が予算を食った等)で本文が空 → 原因の分かるエラーにする。
    if result["status"].as_str() == Some("incomplete") {
        let reason = result["incomplete_details"]["reason"]
            .as_str()
            .unwrap_or("unknown");
        anyhow::bail!(
            "Responses API returned incomplete (reason: {reason}); no output_text. max_output_tokens を増やすか reasoning を下げてください"
        );
    }
    let err = result["error"]["message"]
        .as_str()
        .unwrap_or("no output_text in Responses output");
    anyhow::bail!("Responses API error: {err}")
}

// ---------------------------------------------------------------------------
// Streaming event interpretation (pure / testable)
// ---------------------------------------------------------------------------

/// Responses SSE データイベントを解釈した結果(送出すべきアクション)。
#[derive(Debug, PartialEq)]
pub enum StreamAction {
    /// 本文 delta(block_type=text で emit)。
    TextDelta(String),
    /// 推論要約 delta(block_type=thinking で emit)。
    ThinkingDelta(String),
    /// 最終イベント。usage と終了理由を確定する。
    Completed {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        cache_read_tokens: Option<u64>,
        stop_reason: String,
    },
    /// ストリームエラー(中断して呼び出し側へ伝播)。
    Failed(String),
    /// 無視(他の制御イベント)。
    Ignore,
}

/// 1 つの SSE データ JSON(`{type, ...}`)を `StreamAction` に解釈する。
pub fn interpret_stream_event(json: &Value) -> StreamAction {
    match json["type"].as_str() {
        Some("response.output_text.delta") => {
            let d = json["delta"].as_str().unwrap_or("");
            if d.is_empty() {
                StreamAction::Ignore
            } else {
                StreamAction::TextDelta(d.to_string())
            }
        }
        Some("response.reasoning_summary_text.delta") => {
            let d = json["delta"].as_str().unwrap_or("");
            if d.is_empty() {
                StreamAction::Ignore
            } else {
                StreamAction::ThinkingDelta(d.to_string())
            }
        }
        Some("response.completed") | Some("response.incomplete") => {
            let resp = &json["response"];
            let usage = &resp["usage"];
            let status = resp["status"].as_str().unwrap_or("completed");
            // incomplete は理由(max_output_tokens / content_filter 等)に依らず
            // 打ち切りなので length 扱い(非ストリーム parse_output と揃える)。
            let stop_reason = if status == "incomplete" {
                "length"
            } else {
                "end_turn"
            }
            .to_string();
            StreamAction::Completed {
                input_tokens: usage["input_tokens"].as_u64(),
                output_tokens: usage["output_tokens"].as_u64(),
                cache_read_tokens: usage["input_tokens_details"]["cached_tokens"].as_u64(),
                stop_reason,
            }
        }
        Some("response.failed") => {
            let msg = json["response"]["error"]["message"]
                .as_str()
                .unwrap_or("Responses stream failed")
                .to_string();
            StreamAction::Failed(msg)
        }
        Some("error") => {
            let msg = json["message"]
                .as_str()
                .unwrap_or("Responses stream error")
                .to_string();
            StreamAction::Failed(msg)
        }
        _ => StreamAction::Ignore,
    }
}

// ---------------------------------------------------------------------------
// HTTP transport
// ---------------------------------------------------------------------------

/// `{base}/responses` への POST RequestBuilder を組み立てる。OpenAI は常に Bearer 認証、
/// 互換 gateway はキーが空なら無認証(ローカル proxy 等)。
fn build_request(
    client: &reqwest::Client,
    provider: &AiProvider,
    api_key: &str,
    endpoints: ProviderEndpoints<'_>,
    body: &Value,
) -> reqwest::RequestBuilder {
    let url = format!("{}/responses", provider.base_url(endpoints));
    let mut req = client.post(url).header("content-type", "application/json");
    let needs_auth = match provider {
        AiProvider::OpenaiCompatible => !api_key.is_empty(),
        _ => true,
    };
    if needs_auth {
        req = req.header("Authorization", format!("Bearer {api_key}"));
    }
    // OpenRouter は属性表示用ヘッダーを推奨(/chat/completions 経路と対称)。
    if matches!(provider, AiProvider::OpenRouter) {
        req = req
            .header("HTTP-Referer", "https://github.com/kazormia296/Grimodex")
            .header("X-Title", "Grimodex");
    }
    req.json(body)
}

/// 単発(ツール無し)チャットを Responses で送る。
pub async fn send(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();
    let (instructions, input) = build_chat_input(messages);
    let mut body = base_body(params.model, &instructions, input, None);
    apply_reasoning(
        &mut body,
        params.model,
        params.reasoning_enabled,
        &params.reasoning_effort,
    );
    body["max_output_tokens"] = json!(max_output_tokens(
        params.provider,
        params.model,
        params.reasoning_enabled
    ));
    crate::ai::merge_extra_body(&mut body, &params.extra_body);
    crate::ai::apply_openrouter_provider_pin(
        &mut body,
        params.provider,
        params.openrouter_provider_pin,
    );

    let result = send_and_parse_json(&client, params, &body).await?;
    parse_output(
        &result,
        &ParseResponsesOptions {
            block_mutating_on_native: false,
        },
    )
}

/// ツール付き(Agent)チャットを Responses で送る。
pub async fn send_with_tools(
    params: &ChatParams<'_>,
    messages: &[AgentMessage],
    tools: &[AgentToolDef],
) -> anyhow::Result<ChatResponse> {
    let client = reqwest::Client::new();
    let (instructions, input) = build_agent_input(messages);
    // 空 tools のとき `tools:[]` を送らない(一部互換 gateway が 400)。RAG 単独
    // ターン等でツール定義が空なら tools キー自体を省く。
    let tool_defs = build_tools(tools);
    let tools_opt = if tool_defs.is_empty() {
        None
    } else {
        Some(tool_defs)
    };
    let mut body = base_body(params.model, &instructions, input, tools_opt);
    // 推論モデルの reasoning 継続: encrypted_content を受け取り、次ターンで
    // function_call の前に reasoning item を echo できるようにする(store:false
    // でツールを跨ぐ際の必須要件)。OpenAI 直 / OpenRouter は include を strict 検証せず
    // 公式サポートするため常に付与する(OpenRouter は reasoning モデルへルーティング
    // しても encrypted_content の round-trip が必要で、reasoning_enabled 未指定でも
    // 付けないと2ターン目が HTTP 400 になる)。互換 gateway は未知 include を 400 する
    // 実装がありうるので reasoning を明示 ON にしたときだけ付与する。
    if matches!(params.provider, AiProvider::OpenAI | AiProvider::OpenRouter)
        || params.reasoning_enabled == Some(true)
    {
        body["include"] = json!(["reasoning.encrypted_content"]);
    }
    apply_reasoning(
        &mut body,
        params.model,
        params.reasoning_enabled,
        &params.reasoning_effort,
    );
    body["max_output_tokens"] = json!(max_output_tokens(
        params.provider,
        params.model,
        params.reasoning_enabled
    ));
    crate::ai::merge_extra_body(&mut body, &params.extra_body);
    crate::ai::apply_openrouter_provider_pin(
        &mut body,
        params.provider,
        params.openrouter_provider_pin,
    );
    // RAG: OpenRouter の Web 検索を注入(/chat/completions の Agent 経路と対称)。
    // 検索は agentic=server tool / 非 agentic=web plugin。引用は parse_output が
    // message.annotations の url_citation から収集する。
    crate::ai::apply_openrouter_web_search_to_body(
        &mut body,
        params.provider,
        params.web_search.as_ref(),
    );

    let result = send_and_parse_json(&client, params, &body).await?;
    parse_output(
        &result,
        &ParseResponsesOptions {
            block_mutating_on_native: crate::ai::is_low_trust_native_provider(params.provider),
        },
    )
}

/// 共通: body を送り、HTTP ステータス検査の後 JSON を返す(429 リトライ + wire log 付き)。
async fn send_and_parse_json(
    client: &reqwest::Client,
    params: &ChatParams<'_>,
    body: &Value,
) -> anyhow::Result<Value> {
    if crate::ai::ai_wire_log_enabled() {
        tracing::warn!(
            target: "ai_wire",
            "→ responses request (provider={:?} model={}): {}",
            params.provider,
            params.model,
            crate::ai::truncate_for_log(&body.to_string(), 12000)
        );
    }
    let req = build_request(
        client,
        params.provider,
        params.api_key,
        params.endpoints,
        body,
    );
    let resp = crate::ai::send_with_429_retry(req, params.retry_429, 3).await?;
    let status = resp.status();
    let body_text = resp.text().await?;
    if crate::ai::ai_wire_log_enabled() {
        tracing::warn!(
            target: "ai_wire",
            "← responses response (status={}): {}",
            status,
            crate::ai::truncate_for_log(&body_text, 12000)
        );
    }
    if !status.is_success() {
        anyhow::bail!(
            "Responses API request failed (HTTP {}): {}",
            status,
            crate::ai::truncate_for_log(&body_text, 1500)
        );
    }
    serde_json::from_str(&body_text).map_err(|e| {
        anyhow::anyhow!(
            "Responses API JSON parse failed: {e}; body: {}",
            crate::ai::truncate_for_log(&body_text, 500)
        )
    })
}

/// ストリーミングチャットを Responses で送る。型付き SSE イベントを既存の
/// `{delta, block_type}` chunk / `{stop_reason, ...}` done に正規化して emit する。
pub async fn send_stream(
    params: &ChatParams<'_>,
    messages: &[(&str, &str)],
    abort_flag: Arc<std::sync::atomic::AtomicBool>,
    app_handle: tauri::AppHandle,
    event_prefix: &str,
) -> anyhow::Result<()> {
    use futures::StreamExt;
    use tauri::Emitter;

    let chunk_event = format!("{}:stream-chunk", event_prefix);
    let done_event = format!("{}:stream-done", event_prefix);

    let client = reqwest::Client::new();
    let (instructions, input) = build_chat_input(messages);
    let mut body = base_body(params.model, &instructions, input, None);
    body["stream"] = json!(true);
    apply_reasoning(
        &mut body,
        params.model,
        params.reasoning_enabled,
        &params.reasoning_effort,
    );
    body["max_output_tokens"] = json!(max_output_tokens(
        params.provider,
        params.model,
        params.reasoning_enabled
    ));
    crate::ai::merge_extra_body(&mut body, &params.extra_body);
    crate::ai::apply_openrouter_provider_pin(
        &mut body,
        params.provider,
        params.openrouter_provider_pin,
    );

    let req = build_request(
        &client,
        params.provider,
        params.api_key,
        params.endpoints,
        &body,
    );
    let resp = crate::ai::send_with_429_retry(req, params.retry_429, 3).await?;
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
    let mut cache_read_tokens: Option<u64> = None;

    while let Some(chunk) = stream.next().await {
        if abort_flag.load(Ordering::Relaxed) {
            stop_reason = "stopped".to_string();
            break;
        }
        let bytes = chunk.map_err(|e| anyhow::anyhow!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        if buf.len() > crate::ai::MAX_SSE_BUFFER_BYTES
            && crate::ai::find_sse_frame_separator(&buf).is_none()
        {
            return Err(anyhow::anyhow!(
                "SSE buffer exceeded {} bytes without a frame separator",
                crate::ai::MAX_SSE_BUFFER_BYTES
            ));
        }

        while let Some((pos, sep_len)) = crate::ai::find_sse_frame_separator(&buf) {
            let chunk_str = buf[..pos].to_string();
            buf.drain(..pos + sep_len);

            for line in chunk_str.lines() {
                let Some(rest) = line.strip_prefix("data: ") else {
                    continue;
                };
                let data = rest.trim_end_matches('\r');
                if data == "[DONE]" {
                    break;
                }
                let Ok(json) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                match interpret_stream_event(&json) {
                    StreamAction::TextDelta(d) => {
                        let _ = app_handle
                            .emit(&chunk_event, json!({ "delta": d, "block_type": "text" }));
                    }
                    StreamAction::ThinkingDelta(d) => {
                        let _ = app_handle.emit(
                            &chunk_event,
                            json!({ "delta": d, "block_type": "thinking" }),
                        );
                    }
                    StreamAction::Completed {
                        input_tokens: it,
                        output_tokens: ot,
                        cache_read_tokens: cr,
                        stop_reason: sr,
                    } => {
                        if it.is_some() {
                            input_tokens = it;
                        }
                        if ot.is_some() {
                            output_tokens = ot;
                        }
                        if cr.is_some() {
                            cache_read_tokens = cr;
                        }
                        // abort で既に stopped を立てている場合は上書きしない。
                        if stop_reason != "stopped" {
                            stop_reason = sr;
                        }
                    }
                    StreamAction::Failed(msg) => {
                        return Err(anyhow::anyhow!(msg));
                    }
                    StreamAction::Ignore => {}
                }
            }
        }
    }

    let _ = app_handle.emit(
        &done_event,
        json!({
            "stop_reason": stop_reason,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cost": Value::Null,
            "cache_read_tokens": cache_read_tokens,
            "cache_write_tokens": Value::Null,
        }),
    );
    Ok(())
}

/// 校閲 post-effect の単発呼び出しを Responses で行い、最初の出力テキストを返す。
/// `instructions` に system、`input` に Codex/Scene を `input_text` パートで載せる
/// (OpenAI は prefix を自動キャッシュするため cache_control は付けない)。
pub async fn post_effect(
    settings: &AiSettings,
    api_key: &str,
    system_prompt: &str,
    codex_content: Option<&str>,
    scene_content: &str,
) -> anyhow::Result<String> {
    let client = reqwest::Client::new();
    let endpoints = settings.endpoints();

    let mut parts: Vec<Value> = Vec::new();
    if let Some(codex) = codex_content {
        parts.push(json!({ "type": "input_text", "text": format!("[Codex]\n{}", codex) }));
    }
    parts.push(json!({ "type": "input_text", "text": format!("[Scene]\n{}", scene_content) }));
    let input = vec![json!({ "role": "user", "content": parts })];

    let mut body = base_body(&settings.model, system_prompt, input, None);
    body["max_output_tokens"] = json!(if matches!(settings.provider, AiProvider::OpenAI) {
        32_000
    } else {
        4096
    });
    crate::ai::apply_openrouter_provider_pin(
        &mut body,
        &settings.provider,
        settings.openrouter_provider_pin.as_deref(),
    );

    let req = build_request(&client, &settings.provider, api_key, endpoints, &body);
    let resp = req.send().await?.error_for_status()?;
    let result: Value = resp.json().await?;
    extract_first_output_text(&result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::{ResponseBlock, ThinkingPayload, ToolUsePayload};

    fn tool_use(id: &str, name: &str, input: Value) -> ToolUsePayload {
        ToolUsePayload {
            id: id.to_string(),
            name: name.to_string(),
            input,
        }
    }

    #[test]
    fn uses_responses_api_only_for_openai_family_with_variant() {
        assert!(uses_responses_api(&AiProvider::OpenAI, Some("responses")));
        assert!(uses_responses_api(
            &AiProvider::OpenaiCompatible,
            Some("responses")
        ));
        // OpenRouter も beta `/api/v1/responses` を公開しているので対象。
        assert!(uses_responses_api(
            &AiProvider::OpenRouter,
            Some("responses")
        ));
        // 変種違い / 非対応 provider は false。
        assert!(!uses_responses_api(&AiProvider::OpenAI, Some("v1")));
        assert!(!uses_responses_api(&AiProvider::OpenAI, None));
        assert!(!uses_responses_api(&AiProvider::OpenRouter, Some("v1")));
        assert!(!uses_responses_api(
            &AiProvider::Anthropic,
            Some("responses")
        ));
    }

    #[test]
    fn build_chat_input_splits_system_into_instructions() {
        let msgs = [
            ("system", "S1"),
            ("system", "S2"),
            ("user", "hello"),
            ("assistant", "hi"),
            ("user", "again"),
        ];
        let (instructions, input) = build_chat_input(&msgs);
        assert_eq!(instructions, "S1\nS2");
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"], "hello");
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[2]["content"], "again");
        // system は input に残らない。
        assert!(input.iter().all(|m| m["role"] != "system"));
    }

    #[test]
    fn build_agent_input_emits_function_call_and_output_items() {
        let messages = vec![
            AgentMessage::System {
                content: "SYS".to_string(),
            },
            AgentMessage::User {
                content: "find X".to_string(),
            },
            AgentMessage::Assistant {
                content: "looking".to_string(),
                tool_uses: vec![tool_use("call_1", "search_codex", json!({"q":"X"}))],
                thinking_blocks: vec![],
            },
            AgentMessage::ToolResult {
                tool_use_id: "call_1".to_string(),
                content: "found".to_string(),
                is_error: false,
            },
        ];
        let (instructions, input) = build_agent_input(&messages);
        assert_eq!(instructions, "SYS");
        // user, assistant message(本文), function_call, function_call_output の4要素。
        assert_eq!(input.len(), 4);
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[1]["content"], "looking");
        assert_eq!(input[2]["type"], "function_call");
        assert_eq!(input[2]["call_id"], "call_1");
        assert_eq!(input[2]["name"], "search_codex");
        // arguments は文字列化された JSON。
        assert_eq!(input[2]["arguments"], json!("{\"q\":\"X\"}"));
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "call_1");
        assert_eq!(input[3]["output"], "found");
    }

    #[test]
    fn build_agent_input_skips_empty_assistant_text() {
        // 本文が空でツールだけの assistant は message を出さず function_call のみ。
        let messages = vec![AgentMessage::Assistant {
            content: String::new(),
            tool_uses: vec![tool_use("c1", "get_scene", json!({}))],
            thinking_blocks: vec![],
        }];
        let (_instr, input) = build_agent_input(&messages);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call");
    }

    #[test]
    fn build_agent_input_echoes_reasoning_before_function_call() {
        // 推論モデル継続: signature に {id, ec} を持つ thinking_block は reasoning
        // アイテムとして function_call の前に echo される(store:false の必須要件)。
        let sig = json!({ "id": "rs_1", "ec": "ENC==" }).to_string();
        let messages = vec![AgentMessage::Assistant {
            content: "calling".to_string(),
            tool_uses: vec![tool_use("call_9", "search_codex", json!({}))],
            thinking_blocks: vec![ThinkingPayload {
                thinking: "考え中".to_string(),
                signature: sig,
            }],
        }];
        let (_instr, input) = build_agent_input(&messages);
        // reasoning, assistant message, function_call の順。
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], "reasoning");
        assert_eq!(input[0]["id"], "rs_1");
        assert_eq!(input[0]["encrypted_content"], "ENC==");
        assert!(input[0]["summary"].is_array());
        assert_eq!(input[1]["role"], "assistant");
        assert_eq!(input[2]["type"], "function_call");
    }

    #[test]
    fn build_agent_input_skips_non_json_signature() {
        // Anthropic 由来など {id,ec} 形でない signature は reasoning echo しない。
        let messages = vec![AgentMessage::Assistant {
            content: String::new(),
            tool_uses: vec![tool_use("c1", "get_scene", json!({}))],
            thinking_blocks: vec![ThinkingPayload {
                thinking: "x".to_string(),
                signature: "opaque-anthropic-sig".to_string(),
            }],
        }];
        let (_instr, input) = build_agent_input(&messages);
        // reasoning は出ず function_call のみ。
        assert_eq!(input.len(), 1);
        assert_eq!(input[0]["type"], "function_call");
    }

    #[test]
    fn build_tools_flat_shape_sorted_by_name() {
        let tools = vec![
            AgentToolDef {
                name: "zeta".to_string(),
                description: "Z".to_string(),
                input_schema: json!({"type":"object"}),
            },
            AgentToolDef {
                name: "alpha".to_string(),
                description: "A".to_string(),
                input_schema: json!({"type":"object"}),
            },
        ];
        let out = build_tools(&tools);
        assert_eq!(out.len(), 2);
        // ソート済み(決定的順序)。
        assert_eq!(out[0]["name"], "alpha");
        assert_eq!(out[1]["name"], "zeta");
        // フラット形(function ネスト無し)。
        assert_eq!(out[0]["type"], "function");
        assert_eq!(out[0]["description"], "A");
        assert_eq!(out[0]["parameters"], json!({"type":"object"}));
        assert!(out[0].get("function").is_none());
    }

    #[test]
    fn apply_reasoning_emits_effort_and_summary() {
        let mut body = json!({});
        apply_reasoning(&mut body, "gpt-5", Some(true), &Some("low".to_string()));
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["reasoning"]["summary"], "auto");
    }

    #[test]
    fn apply_reasoning_clamps_max_to_high() {
        let mut body = json!({});
        apply_reasoning(&mut body, "gpt-5", Some(true), &Some("max".to_string()));
        assert_eq!(body["reasoning"]["effort"], "high");
    }

    #[test]
    fn apply_reasoning_gpt5_pro_forced_high() {
        let mut body = json!({});
        apply_reasoning(&mut body, "gpt-5-pro", Some(true), &Some("low".to_string()));
        assert_eq!(body["reasoning"]["effort"], "high");
    }

    #[test]
    fn apply_reasoning_off_minimal_only_for_supported() {
        // gpt-5.1 は minimal 可。
        let mut body = json!({});
        apply_reasoning(&mut body, "gpt-5.1", Some(false), &None);
        assert_eq!(body["reasoning"]["effort"], "minimal");
        // gpt-5(無印) は none/minimal 非対応 → 何も足さない。
        let mut body2 = json!({});
        apply_reasoning(&mut body2, "gpt-5", Some(false), &None);
        assert!(body2.get("reasoning").is_none());
    }

    #[test]
    fn apply_reasoning_none_when_unset() {
        let mut body = json!({});
        apply_reasoning(&mut body, "gpt-4o", None, &None);
        assert!(body.get("reasoning").is_none());
    }

    #[test]
    fn parse_output_text_and_usage() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "message", "role": "assistant",
                  "content": [{ "type": "output_text", "text": "Hello world" }] }
            ],
            "usage": { "input_tokens": 12, "output_tokens": 5 }
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.stop_reason, "end_turn");
        assert_eq!(resp.input_tokens, Some(12));
        assert_eq!(resp.output_tokens, Some(5));
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => assert_eq!(content, "Hello world"),
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn parse_output_reasoning_then_text() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning",
                  "summary": [{ "type": "summary_text", "text": "thinking..." }] },
                { "type": "message", "role": "assistant",
                  "content": [{ "type": "output_text", "text": "answer" }] }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.blocks.len(), 2);
        assert!(matches!(resp.blocks[0], ResponseBlock::Thinking { .. }));
        assert!(matches!(resp.blocks[1], ResponseBlock::Text { .. }));
    }

    #[test]
    fn parse_output_function_call_sets_tool_use() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "function_call", "call_id": "call_42",
                  "name": "search_codex", "arguments": "{\"q\":\"鍵\"}" }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.stop_reason, "tool_use");
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "call_42");
                assert_eq!(name, "search_codex");
                assert_eq!(input["q"], "鍵");
            }
            other => panic!("expected tool_use, got {other:?}"),
        }
    }

    #[test]
    fn parse_output_drops_mutating_tool_on_low_trust() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "function_call", "call_id": "c1",
                  "name": "update_codex_entry", "arguments": "{}" }
            ]
        });
        // 低信頼: mutating は drop され tool_use は残らない → end_turn。
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: true,
            },
        )
        .unwrap();
        assert_eq!(resp.stop_reason, "end_turn");
        assert!(resp.blocks.is_empty());
        // 高信頼: drop しない。
        let resp2 = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp2.stop_reason, "tool_use");
        assert_eq!(resp2.blocks.len(), 1);
    }

    #[test]
    fn parse_output_incomplete_max_tokens_is_length() {
        let result = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": []
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.stop_reason, "length");
    }

    #[test]
    fn parse_output_incomplete_content_filter_is_length() {
        // content_filter 等の打ち切りも end_turn でなく length(空応答を黙認しない)。
        let result = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "content_filter" },
            "output": []
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.stop_reason, "length");
    }

    #[test]
    fn parse_output_reasoning_captures_signature_for_echo() {
        // encrypted_content 付き reasoning は signature(JSON {id, ec})を持ち、
        // summary が複数パートなら \n\n で連結される。
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning", "id": "rs_7", "encrypted_content": "ENC==",
                  "summary": [
                    { "type": "summary_text", "text": "step1" },
                    { "type": "summary_text", "text": "step2" }
                  ] },
                { "type": "message", "role": "assistant",
                  "content": [{ "type": "output_text", "text": "done" }] }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        match &resp.blocks[0] {
            ResponseBlock::Thinking {
                content, signature, ..
            } => {
                assert_eq!(content, "step1\n\nstep2");
                let sig = signature.as_deref().expect("signature present");
                let parsed: Value = serde_json::from_str(sig).unwrap();
                assert_eq!(parsed["id"], "rs_7");
                assert_eq!(parsed["ec"], "ENC==");
            }
            other => panic!("expected thinking, got {other:?}"),
        }
    }

    #[test]
    fn parse_output_reasoning_without_encrypted_content_has_no_signature() {
        // encrypted_content が無ければ echo 不可なので signature は None(表示のみ)。
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "reasoning",
                  "summary": [{ "type": "summary_text", "text": "just text" }] }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        match &resp.blocks[0] {
            ResponseBlock::Thinking { signature, .. } => assert!(signature.is_none()),
            other => panic!("expected thinking, got {other:?}"),
        }
    }

    #[test]
    fn parse_output_surfaces_refusal_as_text() {
        // refusal パートは無言で落とさず Text 化する。
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "message", "role": "assistant", "content": [
                    { "type": "refusal", "refusal": "ごめんなさい、その依頼には応えられません" }
                ] }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        assert_eq!(resp.blocks.len(), 1);
        match &resp.blocks[0] {
            ResponseBlock::Text { content } => {
                assert!(content.contains("応えられません"));
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn parse_output_collects_url_citations() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "message", "role": "assistant", "content": [
                    { "type": "output_text", "text": "see source",
                      "annotations": [
                        { "type": "url_citation", "url": "https://e.com/a", "title": "A" },
                        { "type": "url_citation", "url": "https://e.com/a", "title": "dup" }
                      ] }
                ] }
            ]
        });
        let resp = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap();
        // 同一 URL は 1 件に畳まれる。
        assert_eq!(resp.citations.len(), 1);
        assert_eq!(resp.citations[0].url, "https://e.com/a");
        assert_eq!(resp.citations[0].title, "A");
    }

    #[test]
    fn parse_output_error_envelope_bails() {
        let result = json!({ "error": { "message": "bad request" } });
        let err = parse_output(
            &result,
            &ParseResponsesOptions {
                block_mutating_on_native: false,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("bad request"));
    }

    #[test]
    fn interpret_stream_event_text_delta() {
        let ev = json!({ "type": "response.output_text.delta", "delta": "Hi" });
        assert_eq!(
            interpret_stream_event(&ev),
            StreamAction::TextDelta("Hi".to_string())
        );
        // 空 delta は Ignore。
        let empty = json!({ "type": "response.output_text.delta", "delta": "" });
        assert_eq!(interpret_stream_event(&empty), StreamAction::Ignore);
    }

    #[test]
    fn interpret_stream_event_reasoning_delta() {
        let ev = json!({ "type": "response.reasoning_summary_text.delta", "delta": "mm" });
        assert_eq!(
            interpret_stream_event(&ev),
            StreamAction::ThinkingDelta("mm".to_string())
        );
    }

    #[test]
    fn interpret_stream_event_completed_reads_usage() {
        let ev = json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "usage": {
                    "input_tokens": 30, "output_tokens": 8,
                    "input_tokens_details": { "cached_tokens": 20 }
                }
            }
        });
        match interpret_stream_event(&ev) {
            StreamAction::Completed {
                input_tokens,
                output_tokens,
                cache_read_tokens,
                stop_reason,
            } => {
                assert_eq!(input_tokens, Some(30));
                assert_eq!(output_tokens, Some(8));
                assert_eq!(cache_read_tokens, Some(20));
                assert_eq!(stop_reason, "end_turn");
            }
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn interpret_stream_event_incomplete_is_length() {
        let ev = json!({
            "type": "response.incomplete",
            "response": {
                "status": "incomplete",
                "incomplete_details": { "reason": "max_output_tokens" },
                "usage": { "input_tokens": 1, "output_tokens": 32000 }
            }
        });
        match interpret_stream_event(&ev) {
            StreamAction::Completed { stop_reason, .. } => assert_eq!(stop_reason, "length"),
            other => panic!("expected Completed, got {other:?}"),
        }
    }

    #[test]
    fn interpret_stream_event_failed_and_error() {
        let failed = json!({
            "type": "response.failed",
            "response": { "error": { "message": "boom" } }
        });
        assert_eq!(
            interpret_stream_event(&failed),
            StreamAction::Failed("boom".to_string())
        );
        let error = json!({ "type": "error", "message": "ratelimit" });
        assert_eq!(
            interpret_stream_event(&error),
            StreamAction::Failed("ratelimit".to_string())
        );
        // 未知イベントは Ignore。
        let other = json!({ "type": "response.output_item.added" });
        assert_eq!(interpret_stream_event(&other), StreamAction::Ignore);
    }

    #[test]
    fn extract_first_output_text_prefers_output_text_field() {
        let result = json!({ "output_text": "convenient", "output": [] });
        assert_eq!(extract_first_output_text(&result).unwrap(), "convenient");
    }

    #[test]
    fn extract_first_output_text_falls_back_to_scan() {
        let result = json!({
            "output": [
                { "type": "reasoning", "summary": [] },
                { "type": "message", "content": [
                    { "type": "output_text", "text": "scanned" }
                ] }
            ]
        });
        assert_eq!(extract_first_output_text(&result).unwrap(), "scanned");
    }

    #[test]
    fn extract_first_output_text_refusal_bails_clearly() {
        let result = json!({
            "status": "completed",
            "output": [
                { "type": "message", "content": [
                    { "type": "refusal", "refusal": "denied" }
                ] }
            ]
        });
        let err = extract_first_output_text(&result).unwrap_err();
        assert!(err.to_string().contains("refusal"));
    }

    #[test]
    fn extract_first_output_text_incomplete_bails_with_reason() {
        // 打ち切りで本文空 → 原因(reason)入りエラーで bail("no output_text" にしない)。
        let result = json!({
            "status": "incomplete",
            "incomplete_details": { "reason": "max_output_tokens" },
            "output": []
        });
        let err = extract_first_output_text(&result).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("incomplete"));
        assert!(msg.contains("max_output_tokens"));
    }

    #[test]
    fn max_output_tokens_openai_is_32k() {
        assert_eq!(
            max_output_tokens(&AiProvider::OpenAI, "gpt-5", None),
            32_000
        );
        assert_eq!(
            max_output_tokens(&AiProvider::OpenAI, "gpt-4o", Some(false)),
            32_000
        );
        // 互換 gateway は reasoning ON 時 32k。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenaiCompatible, "gpt-5", Some(true)),
            32_000
        );
        // 非推論モデルで未指定なら 4096。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenaiCompatible, "gpt-4o", None),
            4096
        );
        // gpt-5.1+ は OFF でも minimal reasoning を送るので 32k に広げる。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenaiCompatible, "gpt-5.1", Some(false)),
            32_000
        );
        // gpt-5(無印) は none/minimal 非対応 → OFF では reasoning を送らず 4096。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenaiCompatible, "gpt-5", Some(false)),
            4096
        );
    }

    #[test]
    fn max_output_tokens_openrouter_reasoning_model_is_32k() {
        // OpenRouter 経由の reasoning モデルは reasoning_enabled 未指定でも名前で検出して
        // 予算を広げる(hidden reasoning が max_output_tokens に課金され、4096 では空応答に
        // なりうるため。/chat/completions の openai_max_tokens と同根)。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenRouter, "openai/gpt-5", None),
            32_000
        );
        assert_eq!(
            max_output_tokens(&AiProvider::OpenRouter, "deepseek/deepseek-r1", None),
            32_000
        );
        // 非推論モデルは 4096 のまま。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenRouter, "openai/gpt-4o-mini", None),
            4096
        );
        // gpt-5-chat は非 reasoning なので 4096(is_openrouter_reasoning_model と対称)。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenRouter, "openai/gpt-5-chat", None),
            4096
        );
        // 明示 ON は当然 32k。
        assert_eq!(
            max_output_tokens(&AiProvider::OpenRouter, "anthropic/claude-3.7", Some(true)),
            32_000
        );
    }

    #[test]
    fn base_body_omits_empty_instructions_sets_store_false() {
        let body = base_body(
            "gpt-5",
            "",
            vec![json!({"role":"user","content":"hi"})],
            None,
        );
        assert_eq!(body["model"], "gpt-5");
        assert_eq!(body["store"], false);
        assert!(body.get("instructions").is_none());
        assert!(body.get("tools").is_none());
        // instructions ありなら付く。
        let body2 = base_body(
            "gpt-5",
            "SYS",
            vec![],
            Some(vec![json!({"type":"function"})]),
        );
        assert_eq!(body2["instructions"], "SYS");
        assert!(body2["tools"].is_array());
    }
}

// ---------------------------------------------------------------------------
// ライブ検証(実 /v1/responses)。既定 SKIP。
//   OpenAI 直:
//     OPENAI_API_KEY=sk-... cargo test --no-default-features responses_live -- --nocapture
//     モデル上書き: OPENAI_RESPONSES_MODEL(既定 gpt-4o-mini)。
//   OpenRouter (beta /api/v1/responses):
//     OPENROUTER_API_KEY=sk-or-... cargo test --no-default-features responses_live_openrouter -- --nocapture
//     モデル上書き: OPENROUTER_RESPONSES_MODEL(既定 openai/gpt-4o-mini)。
//   いずれもキー未設定なら個別に [skip] する(CI / sandbox 安全)。
// ---------------------------------------------------------------------------
#[cfg(test)]
mod responses_live_tests {
    use super::*;
    use crate::ai::{
        AiNovelistMode, ChatParams, ResolvedToolProtocol, ThinkingPayload, ToolUsePayload,
    };

    fn live_key() -> Option<String> {
        std::env::var("OPENAI_API_KEY")
            .ok()
            .filter(|k| !k.is_empty())
    }

    fn live_model() -> String {
        std::env::var("OPENAI_RESPONSES_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string())
    }

    fn live_settings() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenAI,
            model: live_model(),
            ..Default::default()
        }
    }

    // --- OpenRouter ---
    fn or_live_key() -> Option<String> {
        std::env::var("OPENROUTER_API_KEY")
            .or_else(|_| std::env::var("OPEN_ROUTER_API_KEY"))
            .ok()
            .filter(|k| !k.is_empty())
    }

    fn or_live_model() -> String {
        std::env::var("OPENROUTER_RESPONSES_MODEL")
            .unwrap_or_else(|_| "openai/gpt-4o-mini".to_string())
    }

    fn or_live_settings() -> AiSettings {
        AiSettings {
            provider: AiProvider::OpenRouter,
            model: or_live_model(),
            ..Default::default()
        }
    }

    /// provider を引数で受け、Responses 経路の ChatParams を組む(OpenAI / OpenRouter 共通)。
    fn live_params<'a>(
        provider: &'a AiProvider,
        settings: &'a AiSettings,
        key: &'a str,
        model: &'a str,
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
            api_variant: Some("responses".to_string()),
            web_search: None,
            resolved_tool_protocol: ResolvedToolProtocol::Native,
        }
    }

    fn weather_tool() -> Vec<AgentToolDef> {
        vec![AgentToolDef {
            name: "get_weather".to_string(),
            description: "指定都市の現在の天気を取得する".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"]
            }),
        }]
    }

    /// 単発(ツール無し)ライブ: 非空本文 + end_turn を検証して本文を返す。
    fn run_single_shot(params: &ChatParams<'_>) -> String {
        let messages = [
            ("system", "あなたは簡潔に答えるアシスタントです。"),
            (
                "user",
                "「鍵」という単語を1回だけ含む短い一文を返してください。",
            ),
        ];
        let resp = rt()
            .block_on(send(params, &messages))
            .unwrap_or_else(|e| panic!("single_shot: API 失敗: {e:#}"));
        let text: String = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert!(!text.is_empty(), "本文テキストが空");
        assert_eq!(resp.stop_reason, "end_turn");
        text
    }

    /// 2ターン継続(tool_use → function_call_output → 最終回答)ライブ: 最終本文を返す。
    /// 推論モデルでは reasoning item の echo が機能しないと2ターン目が 400 になるため、
    /// reasoning encrypted_content round-trip の回帰ゲートを兼ねる(OpenAI / OpenRouter 共通)。
    fn run_tool_multiturn(params: &ChatParams<'_>) -> String {
        let tools = weather_tool();
        let turn1 = vec![
            AgentMessage::System {
                content: "天気を聞かれたら get_weather を使い、結果を一言で伝えてください。"
                    .to_string(),
            },
            AgentMessage::User {
                content: "東京の天気は？".to_string(),
            },
        ];
        let r1 = rt()
            .block_on(send_with_tools(params, &turn1, &tools))
            .unwrap_or_else(|e| panic!("turn1 失敗: {e:#}"));

        // response blocks → assistant メッセージ(tool_uses + thinking_blocks)へ復元。
        let mut content = String::new();
        let mut tool_uses = Vec::new();
        let mut thinking_blocks = Vec::new();
        let mut first_call_id = String::new();
        for b in &r1.blocks {
            match b {
                ResponseBlock::Text { content: c } => content.push_str(c),
                ResponseBlock::ToolUse { id, name, input } => {
                    if first_call_id.is_empty() {
                        first_call_id = id.clone();
                    }
                    tool_uses.push(ToolUsePayload {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                }
                ResponseBlock::Thinking { signature, .. } => {
                    if let Some(sig) = signature {
                        thinking_blocks.push(ThinkingPayload {
                            thinking: String::new(),
                            signature: sig.clone(),
                        });
                    }
                }
            }
        }
        assert!(!first_call_id.is_empty(), "turn1 で tool_use が無い");

        let mut turn2 = turn1;
        turn2.push(AgentMessage::Assistant {
            content,
            tool_uses,
            thinking_blocks,
        });
        turn2.push(AgentMessage::ToolResult {
            tool_use_id: first_call_id,
            content: "晴れ、22度".to_string(),
            is_error: false,
        });
        let r2 = rt()
            .block_on(send_with_tools(params, &turn2, &tools))
            .unwrap_or_else(|e| panic!("turn2 失敗(reasoning echo 欠落の疑い): {e:#}"));
        let text: String = r2
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert!(!text.is_empty(), "turn2 の最終回答が空: {:?}", r2.blocks);
        text
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime")
    }

    fn post_effect_grader(settings: &AiSettings, key: &str) -> String {
        rt()
            .block_on(post_effect(
                settings,
                key,
                "あなたは小説の校閲者です。シーン本文を分析し JSON オブジェクト {\"ok\":true} だけを返してください。説明やコードフェンスは不要。",
                None,
                "朱音は棚の奥で古い真鍮の鍵を見つけた。",
            ))
            .unwrap_or_else(|e| panic!("post_effect: API 失敗: {e:#}"))
    }

    // ===== OpenAI 直 =====

    #[test]
    fn single_shot_live() {
        let Some(key) = live_key() else {
            eprintln!("[skip] single_shot_live: OPENAI_API_KEY 未設定");
            return;
        };
        let settings = live_settings();
        let model = live_model();
        let params = live_params(&AiProvider::OpenAI, &settings, &key, &model);
        let text = run_single_shot(&params);
        eprintln!("[ok] single_shot_live: {} chars", text.chars().count());
    }

    #[test]
    fn tool_call_live() {
        let Some(key) = live_key() else {
            eprintln!("[skip] tool_call_live: OPENAI_API_KEY 未設定");
            return;
        };
        let settings = live_settings();
        let model = live_model();
        let params = live_params(&AiProvider::OpenAI, &settings, &key, &model);
        let messages = vec![
            AgentMessage::System {
                content: "ユーザーが場所の天気を尋ねたら必ず get_weather ツールを使ってください。"
                    .to_string(),
            },
            AgentMessage::User {
                content: "東京の天気は？".to_string(),
            },
        ];
        let tools = weather_tool();
        let resp = rt()
            .block_on(send_with_tools(&params, &messages, &tools))
            .unwrap_or_else(|e| panic!("tool_call_live: API 失敗: {e:#}"));
        let has_tool = resp
            .blocks
            .iter()
            .any(|b| matches!(b, ResponseBlock::ToolUse { name, .. } if name == "get_weather"));
        assert!(
            has_tool,
            "get_weather の tool_use が無い: {:?}",
            resp.blocks
        );
        assert_eq!(resp.stop_reason, "tool_use");
        eprintln!("[ok] tool_call_live");
    }

    #[test]
    fn tool_call_multiturn_live() {
        let Some(key) = live_key() else {
            eprintln!("[skip] tool_call_multiturn_live: OPENAI_API_KEY 未設定");
            return;
        };
        let settings = live_settings();
        let model = live_model();
        let params = live_params(&AiProvider::OpenAI, &settings, &key, &model);
        let text = run_tool_multiturn(&params);
        eprintln!("[ok] tool_call_multiturn_live: {}", text.trim());
    }

    #[test]
    fn post_effect_live() {
        let Some(key) = live_key() else {
            eprintln!("[skip] post_effect_live: OPENAI_API_KEY 未設定");
            return;
        };
        let raw = post_effect_grader(&live_settings(), &key);
        assert!(!raw.trim().is_empty(), "応答が空");
        eprintln!("[ok] post_effect_live: {} chars", raw.chars().count());
    }

    // ===== OpenRouter (beta /api/v1/responses) =====
    // 実 OpenRouter の Responses 経路(ヘッダー / provider pin / reasoning echo 込み)を、
    // OpenAI と同一の Rust ビルダー/パーサで叩いて検証する。OPENROUTER_API_KEY が無ければ skip。

    #[test]
    fn single_shot_live_openrouter() {
        let Some(key) = or_live_key() else {
            eprintln!("[skip] single_shot_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let settings = or_live_settings();
        let model = or_live_model();
        let params = live_params(&AiProvider::OpenRouter, &settings, &key, &model);
        let text = run_single_shot(&params);
        eprintln!(
            "[ok] single_shot_live_openrouter: {} chars",
            text.chars().count()
        );
    }

    #[test]
    fn tool_call_multiturn_live_openrouter() {
        // OpenRouter の2ターンツール継続。reasoning モデル
        // (OPENROUTER_RESPONSES_MODEL=openai/gpt-5-mini 等)では include
        // ["reasoning.encrypted_content"] の echo が効かないと2ターン目が 400 になるため、
        // OpenRouter 経路でも reasoning round-trip の回帰ゲートになる。
        let Some(key) = or_live_key() else {
            eprintln!("[skip] tool_call_multiturn_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let settings = or_live_settings();
        let model = or_live_model();
        let params = live_params(&AiProvider::OpenRouter, &settings, &key, &model);
        let text = run_tool_multiturn(&params);
        eprintln!("[ok] tool_call_multiturn_live_openrouter: {}", text.trim());
    }

    #[test]
    fn post_effect_live_openrouter() {
        let Some(key) = or_live_key() else {
            eprintln!("[skip] post_effect_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let raw = post_effect_grader(&or_live_settings(), &key);
        assert!(!raw.trim().is_empty(), "応答が空");
        eprintln!(
            "[ok] post_effect_live_openrouter: {} chars",
            raw.chars().count()
        );
    }

    #[test]
    fn web_search_live_openrouter() {
        // OpenRouter + Responses + RAG の回帰ゲート。Responses body へ web plugin
        // (非 agentic) を注入し、(1) 400 にならず受理されること、(2) url_citation が
        // parse_output で収集されること、を確認する。web plugin は毎ターン強制検索する
        // ため引用が返るはず(agentic はモデル裁量で flaky なので非 agentic を採用)。
        let Some(key) = or_live_key() else {
            eprintln!("[skip] web_search_live_openrouter: OPENROUTER_API_KEY 未設定");
            return;
        };
        let settings = or_live_settings();
        let model = or_live_model();
        let mut params = live_params(&AiProvider::OpenRouter, &settings, &key, &model);
        params.web_search = Some(crate::ai::WebSearchConfig {
            enabled: true,
            agentic: false,
            ..Default::default()
        });
        let tools = weather_tool();
        let messages = vec![
            AgentMessage::System {
                content: "提供された検索結果を使って簡潔に答えてください。".to_string(),
            },
            AgentMessage::User {
                content: "OpenRouter の最新の発表を1つ、出典付きで教えてください。".to_string(),
            },
        ];
        let resp = rt()
            .block_on(send_with_tools(&params, &messages, &tools))
            .unwrap_or_else(|e| {
                panic!("web_search_live_openrouter: API 失敗(web plugin の wire shape 拒否の疑い): {e:#}")
            });
        let text: String = resp
            .blocks
            .iter()
            .filter_map(|b| match b {
                ResponseBlock::Text { content } => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert!(!text.trim().is_empty(), "本文が空: {:?}", resp.blocks);
        eprintln!(
            "[ok] web_search_live_openrouter: {} chars, citations={}",
            text.chars().count(),
            resp.citations.len()
        );
    }
}
