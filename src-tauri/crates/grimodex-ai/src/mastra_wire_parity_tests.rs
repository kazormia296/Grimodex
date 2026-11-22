//! Mastra adapter の経路と現行の renderer の経路で、`send_agent_message` の args が同じなら
//! Rust が provider へ送る body が bytes で同一であることを確かめる（MP-2、計画書 §8.1）。
//!
//! 方法:
//! - args（N-API `send_agent_message` の args の JSON）から、napi と同じ変換
//!   （`apply_provider_override` → `resolve_api_variant` → `build_chat_params`）で `ChatParams` を作る。
//! - 実際の `send_chat_with_tools` を呼び、`HttpRetryObserver::request_prepared` で最終 body を捕まえ、
//!   Err を返して送信前に止める（`attempt_started` 以降に進まない＝接続は起きない）。
//!   Anthropic・Chat Completions・Responses の 3 経路は、いずれも `send_with_429_retry` の
//!   最初でこの callback を呼ぶ。
//! - URL と header は observer に出ない（`HttpPreparedRequest` は body だけ）ため、同じ `ChatParams` から
//!   各経路の request builder で組み立てて比べる（経路の振分けは `send_chat_with_tools` の写し）。
//! - 入力は TS 側が書き出す fixture（`electron/main/mastra/__fixtures__/wire-args/`）。
//!   中身は `{ "current": [args...], "adapter": [args...] }`。
//!
//! serde_json は `preserve_order` が要る（addon の build と同じ条件。dev-dependencies で有効化）。
//! 無いと object の key が辞書順になり、tool_use の `input` の key 順の差を検出できない。

use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
use std::sync::Mutex;

/// 送信前に止めるので実 key は使わない。
const DUMMY_API_KEY: &str = "dummy-key-not-a-real-credential";
const SETTINGS_DEFAULT_MODEL: &str = "settings-default-model";

// ---------------------------------------------------------------------------
// route
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Route {
    Anthropic,
    OpenaiChat,
    OpenaiResponses,
    OpenrouterChatClaude,
    OpenrouterChat,
    OpenrouterResponses,
}

impl Route {
    /// 長い名前を先にする（`openrouter-chat-claude` を `openrouter-chat` より先に照合）。
    const ALL: [Route; 6] = [
        Route::OpenrouterChatClaude,
        Route::OpenrouterResponses,
        Route::OpenrouterChat,
        Route::OpenaiResponses,
        Route::OpenaiChat,
        Route::Anthropic,
    ];

    fn name(self) -> &'static str {
        match self {
            Route::Anthropic => "anthropic",
            Route::OpenaiChat => "openai-chat",
            Route::OpenaiResponses => "openai-responses",
            Route::OpenrouterChatClaude => "openrouter-chat-claude",
            Route::OpenrouterChat => "openrouter-chat",
            Route::OpenrouterResponses => "openrouter-responses",
        }
    }

    fn provider(self) -> AiProvider {
        match self {
            Route::Anthropic => AiProvider::Anthropic,
            Route::OpenaiChat | Route::OpenaiResponses => AiProvider::OpenAI,
            Route::OpenrouterChatClaude | Route::OpenrouterChat | Route::OpenrouterResponses => {
                AiProvider::OpenRouter
            }
        }
    }

    /// `<route>-<scene>` の file 名から route を決める。
    fn from_fixture_stem(stem: &str) -> Option<Route> {
        Route::ALL.into_iter().find(|route| {
            stem == route.name()
                || stem
                    .strip_prefix(route.name())
                    .is_some_and(|rest| rest.starts_with('-'))
        })
    }

    /// args が、その route 名の経路に本当に入ることを確かめる（fixture の取り違えを検出する）。
    fn check_effective(self, facts: &EffectiveRoute) -> Result<(), String> {
        let (want_provider, want_responses, want_claude) = match self {
            Route::Anthropic => (AiProvider::Anthropic, false, None),
            Route::OpenaiChat => (AiProvider::OpenAI, false, None),
            Route::OpenaiResponses => (AiProvider::OpenAI, true, None),
            Route::OpenrouterChatClaude => (AiProvider::OpenRouter, false, Some(true)),
            Route::OpenrouterChat => (AiProvider::OpenRouter, false, Some(false)),
            Route::OpenrouterResponses => (AiProvider::OpenRouter, true, None),
        };
        if facts.provider != want_provider {
            return Err(format!(
                "route {}: provider {:?} (期待 {:?})",
                self.name(),
                facts.provider,
                want_provider
            ));
        }
        if facts.uses_responses != want_responses {
            return Err(format!(
                "route {}: uses_responses={} (期待 {}、apiVariant={:?})",
                self.name(),
                facts.uses_responses,
                want_responses,
                facts.api_variant
            ));
        }
        if let Some(want) = want_claude {
            if facts.model.contains("claude") != want {
                return Err(format!(
                    "route {}: model {:?} の claude 判定が期待 {} と違う",
                    self.name(),
                    facts.model,
                    want
                ));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// napi の `AgentRequest` と同じ args の読み取り
// ---------------------------------------------------------------------------

/// `electron/native/grimodex-node/src/lib.rs` の `AgentRequest` の写し。
/// body に影響しない欄（auditContext / callerIdentity）は含めない。
/// 欄を足したら、下の drift 試験（`wire_args_mirror_matches_napi_agent_request`）が落ちる。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireArgs {
    messages: Vec<AgentMessage>,
    tools: Vec<AgentToolDef>,
    thinking: Option<ThinkingConfig>,
    effort: Option<String>,
    reasoning_enabled: Option<bool>,
    reasoning_effort: Option<String>,
    system_cache_segments: Option<Vec<String>>,
    api_variant: Option<String>,
    web_search: Option<WebSearchConfig>,
    system_volatile_tail: Option<String>,
    model: Option<String>,
    provider: Option<AiProvider>,
    endpoint_id: Option<String>,
    request_max_output_tokens: Option<u32>,
    resolved_tool_protocol: Option<ResolvedToolProtocol>,
}

/// `WireArgs` が読む欄（camelCase）。
const READ_ARG_KEYS: [&str; 15] = [
    "messages",
    "tools",
    "thinking",
    "effort",
    "reasoningEnabled",
    "reasoningEffort",
    "systemCacheSegments",
    "apiVariant",
    "webSearch",
    "systemVolatileTail",
    "model",
    "provider",
    "endpointId",
    "requestMaxOutputTokens",
    "resolvedToolProtocol",
];

/// napi の `AgentRequest` が持つが、body には入らない欄（drift 試験で napi の欄と突き合わせる）。
/// napi の `AgentRequest` に無い args の欄（例 `chatMessageId`）は serde が捨てるので、読まない。
const IGNORED_ARG_KEYS: [&str; 3] = ["auditContext", "callerIdentity", "expectedOllamaEndpoint"];

// ---------------------------------------------------------------------------
// 送信前に止める observer
// ---------------------------------------------------------------------------

#[derive(Default)]
struct StopBeforeSendObserver {
    prepared: Mutex<Vec<HttpPreparedRequest>>,
    started: AtomicUsize,
    finished: AtomicUsize,
}

impl HttpRetryObserver for StopBeforeSendObserver {
    fn request_prepared(&self, request: &HttpPreparedRequest) -> anyhow::Result<()> {
        self.prepared.lock().unwrap().push(request.clone());
        anyhow::bail!("wire parity capture: stop before send")
    }
    fn attempt_started(&self, _attempt: &HttpAttemptStarted) -> anyhow::Result<()> {
        self.started.fetch_add(1, AtomicOrdering::SeqCst);
        anyhow::bail!("wire parity capture: attempt_started must not be reached")
    }
    fn attempt_finished(&self, _attempt: &HttpAttemptFinished) -> anyhow::Result<()> {
        self.finished.fetch_add(1, AtomicOrdering::SeqCst);
        anyhow::bail!("wire parity capture: attempt_finished must not be reached")
    }
}

// ---------------------------------------------------------------------------
// 1 call の wire を取る
// ---------------------------------------------------------------------------

struct EffectiveRoute {
    provider: AiProvider,
    model: String,
    api_variant: Option<String>,
    uses_responses: bool,
}

struct Wire {
    /// `serde_json::to_string(body)`。`preserve_order` で、送信 bytes の key 順を保つ。
    body: String,
    url: String,
    /// `name: value` を name で整列したもの。
    headers: Vec<String>,
    effective: EffectiveRoute,
}

/// URL と header。`send_chat_with_tools` の振分け（Responses → Anthropic → Chat Completions）の写し。
fn request_head(
    params: &ChatParams<'_>,
    body: &serde_json::Value,
) -> anyhow::Result<(String, Vec<String>)> {
    // Client の生成は遅い（TLS の root 読込）ので 1 つを使い回す。
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = CLIENT.get_or_init(reqwest::Client::new);
    let builder =
        if ai_responses::uses_responses_api(params.provider, params.api_variant.as_deref()) {
            ai_responses::build_request(
                client,
                params.provider,
                params.api_key,
                params.endpoints,
                body,
            )
        } else if matches!(params.provider, AiProvider::Anthropic) {
            anthropic_request(client, params, body)
        } else {
            openai_compat_request(client, params, body)
        };
    let request = builder.build()?;
    let mut headers: Vec<String> = request
        .headers()
        .iter()
        .map(|(name, value)| format!("{}: {}", name, value.to_str().unwrap_or("<non-utf8>")))
        .collect();
    headers.sort();
    Ok((request.url().to_string(), headers))
}

/// napi `send_agent_message` と同じ変換で `ChatParams` を作り、実際の送信関数を呼んで最終 body を取る。
/// settings はダミー（provider は route から、model は args の override が無ければ既定値）。
async fn capture_wire(route: Route, args: &serde_json::Value) -> anyhow::Result<Wire> {
    let req: WireArgs = serde_json::from_value(args.clone())?;

    let settings = AiSettings {
        provider: route.provider(),
        model: SETTINGS_DEFAULT_MODEL.to_string(),
        ..AiSettings::default()
    };
    // ↓ napi（electron/native/grimodex-node/src/lib.rs の send_agent_message）と同じ順序。
    let settings_for_call = apply_provider_override(
        settings,
        req.model.as_deref(),
        req.provider,
        req.endpoint_id.as_deref(),
    );
    let variant = req.api_variant.as_deref();
    let extra_body = build_ai_novelist_extra_body(&settings_for_call, variant);
    let retry_429 = should_retry_429(&settings_for_call);
    let resolved_variant =
        resolve_api_variant(variant, &settings_for_call, &settings_for_call.model);
    let mut params = build_chat_params(
        &settings_for_call,
        DUMMY_API_KEY,
        extra_body,
        retry_429,
        AiNovelistMode::Chat,
        resolved_variant,
        req.thinking,
        req.effort,
        req.reasoning_enabled,
        req.reasoning_effort,
        req.system_cache_segments,
        req.system_volatile_tail,
        req.web_search,
    );
    params.request_max_output_tokens = req.request_max_output_tokens;
    if let Some(resolved_tool_protocol) = req.resolved_tool_protocol {
        params.resolved_tool_protocol = resolved_tool_protocol;
    }
    // ↑ ここまで。

    let observer = Arc::new(StopBeforeSendObserver::default());
    params.http_retry_observer = Some(observer.clone());

    let outcome = send_chat_with_tools(&params, &req.messages, &req.tools).await;
    let error = match outcome {
        Ok(_) => anyhow::bail!("送信前に止まらなかった（observer が効いていない）"),
        Err(error) => error,
    };
    anyhow::ensure!(
        error
            .to_string()
            .contains("HTTP effective request audit failed before send"),
        "送信前の observer 以外の理由で失敗した: {error:#}"
    );
    anyhow::ensure!(
        observer.started.load(AtomicOrdering::SeqCst) == 0
            && observer.finished.load(AtomicOrdering::SeqCst) == 0,
        "attempt_started/finished に進んだ（送信に進んだ可能性）"
    );
    let prepared = observer.prepared.lock().unwrap();
    anyhow::ensure!(
        prepared.len() == 1,
        "request_prepared が {} 回（期待 1）",
        prepared.len()
    );
    let body_value = prepared[0]
        .body
        .clone()
        .ok_or_else(|| anyhow::anyhow!("prepared body が None（観測が不完全）"))?;
    let (url, headers) = request_head(&params, &body_value)?;
    let effective = EffectiveRoute {
        provider: params.provider.clone(),
        model: params.model.to_string(),
        api_variant: params.api_variant.clone(),
        uses_responses: ai_responses::uses_responses_api(
            params.provider,
            params.api_variant.as_deref(),
        ),
    };
    Ok(Wire {
        body: serde_json::to_string(&body_value)?,
        url,
        headers,
        effective,
    })
}

// ---------------------------------------------------------------------------
// 比較
// ---------------------------------------------------------------------------

fn first_difference(a: &str, b: &str) -> String {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let at = a
        .iter()
        .zip(b.iter())
        .position(|(x, y)| x != y)
        .unwrap_or_else(|| a.len().min(b.len()));
    let window = |s: &[u8]| {
        let from = at.saturating_sub(60);
        let to = (at + 60).min(s.len());
        String::from_utf8_lossy(&s[from..to]).into_owned()
    };
    format!(
        "最初の差は byte {at}（長さ {} と {}）\n  current: …{}…\n  adapter: …{}…",
        a.len(),
        b.len(),
        window(a),
        window(b)
    )
}

fn compare_wires(current: &Wire, adapter: &Wire) -> Result<(), String> {
    if current.body != adapter.body {
        return Err(format!(
            "body が違う。{}",
            first_difference(&current.body, &adapter.body)
        ));
    }
    if current.url != adapter.url {
        return Err(format!("URL が違う: {} と {}", current.url, adapter.url));
    }
    if current.headers != adapter.headers {
        return Err(format!(
            "header が違う: {:?} と {:?}",
            current.headers, adapter.headers
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// fixture（TS 側が書き出す）
// ---------------------------------------------------------------------------

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../electron/main/mastra/__fixtures__/wire-args")
}

#[tokio::test]
async fn mastra_adapter_wire_bytes_equal_current_path() {
    let dir = fixture_dir();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| {
            panic!(
                "fixture dir を読めない（TS 側が書き出す前か）: {}: {error}",
                dir.display()
            )
        })
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(
        !files.is_empty(),
        "fixture が 0 件: {}（0 件を成功にしない）",
        dir.display()
    );

    let mut failures: Vec<String> = Vec::new();
    let mut covered: Vec<Route> = Vec::new();
    let mut compared_calls = 0usize;
    for path in &files {
        let label = path.file_name().unwrap().to_string_lossy().into_owned();
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        let Some(route) = Route::from_fixture_stem(&stem) else {
            failures.push(format!("{label}: route 名で始まらない"));
            continue;
        };
        covered.push(route);
        let parsed: serde_json::Value = match std::fs::read_to_string(path)
            .map_err(anyhow::Error::from)
            .and_then(|text| serde_json::from_str(&text).map_err(anyhow::Error::from))
        {
            Ok(value) => value,
            Err(error) => {
                failures.push(format!("{label}: 読めない: {error:#}"));
                continue;
            }
        };
        let (Some(current), Some(adapter)) = (
            parsed.get("current").and_then(|v| v.as_array()),
            parsed.get("adapter").and_then(|v| v.as_array()),
        ) else {
            failures.push(format!("{label}: current／adapter の配列が無い"));
            continue;
        };
        if current.is_empty() || current.len() != adapter.len() {
            failures.push(format!(
                "{label}: call 数が 0 か不一致（current {}、adapter {}）",
                current.len(),
                adapter.len()
            ));
            continue;
        }
        for (index, (current_args, adapter_args)) in current.iter().zip(adapter.iter()).enumerate()
        {
            let call = format!("{label} call#{index}");
            let (current_wire, adapter_wire) = match (
                capture_wire(route, current_args).await,
                capture_wire(route, adapter_args).await,
            ) {
                (Ok(a), Ok(b)) => (a, b),
                (a, b) => {
                    failures.push(format!(
                        "{call}: wire を取れない（current: {}、adapter: {}）",
                        a.err()
                            .map(|e| format!("{e:#}"))
                            .unwrap_or_else(|| "ok".into()),
                        b.err()
                            .map(|e| format!("{e:#}"))
                            .unwrap_or_else(|| "ok".into()),
                    ));
                    continue;
                }
            };
            for (side, wire) in [("current", &current_wire), ("adapter", &adapter_wire)] {
                if let Err(message) = route.check_effective(&wire.effective) {
                    failures.push(format!("{call} {side}: {message}"));
                }
            }
            if let Err(message) = compare_wires(&current_wire, &adapter_wire) {
                failures.push(format!("{call}: {message}"));
            }
            compared_calls += 1;
        }
    }
    for route in Route::ALL {
        if !covered.contains(&route) {
            failures.push(format!("route {} の fixture が無い", route.name()));
        }
    }
    assert!(
        failures.is_empty(),
        "wire parity が崩れた（{compared_calls} call 比較）:\n{}",
        failures.join("\n")
    );
}

// ---------------------------------------------------------------------------
// harness の自己試験（TS の fixture に依らない）
// ---------------------------------------------------------------------------

fn sample_args(route: Route, tool_input_json: &str, schema_json: &str) -> serde_json::Value {
    let (model, extra) = match route {
        Route::Anthropic => (
            "claude-sonnet-4-6",
            r#""thinking":{"type":"adaptive","effort":"high"},"#,
        ),
        Route::OpenaiChat => (
            "gpt-5.1",
            r#""reasoningEnabled":true,"reasoningEffort":"medium","#,
        ),
        Route::OpenaiResponses => (
            "gpt-5.1",
            r#""apiVariant":"responses","reasoningEnabled":true,"reasoningEffort":"medium","#,
        ),
        Route::OpenrouterChatClaude => ("anthropic/claude-sonnet-4.5", ""),
        Route::OpenrouterChat => ("google/gemini-2.5-pro", ""),
        Route::OpenrouterResponses => ("openai/gpt-5.1", r#""apiVariant":"responses","#),
    };
    let text = format!(
        r#"{{
          "messages": [
            {{"role":"system","content":"SYSTEM-FALLBACK"}},
            {{"role":"user","content":"hello"}},
            {{"role":"assistant","content":"calling","toolUses":[{{"id":"call_1","name":"search_codex","input":{tool_input_json}}}],"thinkingBlocks":[]}},
            {{"role":"tool_result","toolUseId":"call_1","content":"result text","isError":false}}
          ],
          "tools": [{{"name":"search_codex","description":"search","inputSchema":{schema_json}}}],
          "systemCacheSegments": ["segment-a","segment-b"],
          "systemVolatileTail": "volatile-tail",
          "requestMaxOutputTokens": 4096,
          "model": "{model}",
          "provider": "{provider}",
          {extra}
          "expectedOllamaEndpoint": null,
          "auditContext": {{"anything":"ignored"}}
        }}"#,
        provider = route.provider(),
    );
    serde_json::from_str(&text).expect("sample args is valid JSON")
}

const SAMPLE_INPUT: &str = r#"{"query":"scene","limit":3,"kind":"character"}"#;
const SAMPLE_SCHEMA: &str = r#"{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"number"}},"required":["query"]}"#;

#[test]
fn serde_json_preserves_object_key_order_in_this_build() {
    // preserve_order が無いと、object の key が辞書順に並び直される。
    let text = r#"{"z":1,"a":{"y":2,"b":3},"m":[{"q":1,"c":2}]}"#;
    let value: serde_json::Value = serde_json::from_str(text).unwrap();
    assert_eq!(serde_json::to_string(&value).unwrap(), text);
    let built = serde_json::json!({ "z": 1, "a": 2 });
    assert_eq!(serde_json::to_string(&built).unwrap(), r#"{"z":1,"a":2}"#);
    // float_roundtrip：最近接の f64 に戻る（addon の build と同じ条件）。
    let float: serde_json::Value = serde_json::from_str("0.30000000000000004").unwrap();
    assert_eq!(
        serde_json::to_string(&float).unwrap(),
        "0.30000000000000004"
    );
}

#[tokio::test]
async fn observer_reaches_all_three_send_paths_before_the_network() {
    for route in Route::ALL {
        let args = sample_args(route, SAMPLE_INPUT, SAMPLE_SCHEMA);
        let wire = capture_wire(route, &args)
            .await
            .unwrap_or_else(|error| panic!("{}: {error:#}", route.name()));
        route
            .check_effective(&wire.effective)
            .unwrap_or_else(|message| panic!("{message}"));
        let body: serde_json::Value = serde_json::from_str(&wire.body).unwrap();
        // どの経路でも、tool の入力は key 順のまま wire に出る。
        assert!(
            wire.body
                .contains(r#"{\"query\":\"scene\",\"limit\":3,\"kind\":\"character\"}"#)
                || wire.body.contains(SAMPLE_INPUT),
            "{}: tool input の key 順が body に無い: {}",
            route.name(),
            wire.body
        );
        assert!(
            wire.body
                .contains(r#""properties":{"query":{"type":"string"},"limit":{"type":"number"}}"#),
            "{}: tool schema の key 順が body に無い",
            route.name()
        );
        match route {
            Route::Anthropic => {
                assert_eq!(wire.url, "https://api.anthropic.com/v1/messages");
                assert_eq!(body["system"][0]["cache_control"]["type"], "ephemeral");
                assert_eq!(body["max_tokens"], 4096);
                assert!(wire
                    .headers
                    .iter()
                    .any(|h| h == "anthropic-beta: prompt-caching-2024-07-31"));
            }
            Route::OpenaiChat => {
                assert_eq!(wire.url, "https://api.openai.com/v1/chat/completions");
                assert_eq!(body["messages"][0]["content"], "SYSTEM-FALLBACK");
            }
            Route::OpenaiResponses => {
                assert_eq!(wire.url, "https://api.openai.com/v1/responses");
                assert!(body.get("input").is_some());
                assert_eq!(body["include"][0], "reasoning.encrypted_content");
            }
            Route::OpenrouterChatClaude => {
                assert_eq!(wire.url, "https://openrouter.ai/api/v1/chat/completions");
                assert_eq!(
                    body["messages"][0]["content"][0]["cache_control"]["type"],
                    "ephemeral"
                );
            }
            Route::OpenrouterChat => {
                assert_eq!(wire.url, "https://openrouter.ai/api/v1/chat/completions");
                assert_eq!(body["messages"][0]["content"], "SYSTEM-FALLBACK");
            }
            Route::OpenrouterResponses => {
                assert_eq!(wire.url, "https://openrouter.ai/api/v1/responses");
                assert!(body.get("input").is_some());
            }
        }
        // 同じ args からは同じ wire（決定的）。
        let again = capture_wire(route, &args).await.unwrap();
        compare_wires(&wire, &again)
            .unwrap_or_else(|message| panic!("{}: {message}", route.name()));
    }
}

/// 陰性対照：tool_use の `input` か tool schema の key 順だけが違う args は、bytes が異なる。
/// （`preserve_order` が効いていることの証拠。効いていないと、この試験が落ちる。）
#[tokio::test]
async fn negative_control_tool_use_input_key_order_changes_wire_bytes() {
    const SWAPPED_INPUT: &str = r#"{"kind":"character","limit":3,"query":"scene"}"#;
    const SWAPPED_SCHEMA: &str = r#"{"type":"object","properties":{"limit":{"type":"number"},"query":{"type":"string"}},"required":["query"]}"#;
    for route in Route::ALL {
        let base = capture_wire(route, &sample_args(route, SAMPLE_INPUT, SAMPLE_SCHEMA))
            .await
            .unwrap();
        let swapped_input = capture_wire(route, &sample_args(route, SWAPPED_INPUT, SAMPLE_SCHEMA))
            .await
            .unwrap();
        let swapped_schema = capture_wire(route, &sample_args(route, SAMPLE_INPUT, SWAPPED_SCHEMA))
            .await
            .unwrap();
        let input_diff = compare_wires(&base, &swapped_input);
        assert!(
            input_diff
                .as_ref()
                .err()
                .is_some_and(|m| m.starts_with("body が違う")),
            "{}: input の key 順の差を検出できない: {input_diff:?}",
            route.name()
        );
        let schema_diff = compare_wires(&base, &swapped_schema);
        assert!(
            schema_diff
                .as_ref()
                .err()
                .is_some_and(|m| m.starts_with("body が違う")),
            "{}: schema の key 順の差を検出できない: {schema_diff:?}",
            route.name()
        );
        // 値は同じ（key 順だけ違う）ことも確かめる。
        let a: serde_json::Value = serde_json::from_str(&base.body).unwrap();
        let b: serde_json::Value = serde_json::from_str(&swapped_input.body).unwrap();
        assert_ne!(base.body, swapped_input.body);
        assert_eq!(
            a.as_object().map(|o| o.len()),
            b.as_object().map(|o| o.len())
        );
    }
}

#[tokio::test]
async fn unread_args_do_not_change_wire_and_malformed_args_are_rejected() {
    // napi の AgentRequest に無い欄（renderer の chatMessageId など）は serde が捨てる。
    let base = sample_args(Route::Anthropic, SAMPLE_INPUT, SAMPLE_SCHEMA);
    let mut extra = base.clone();
    extra["chatMessageId"] = serde_json::json!("asst-1");
    extra["auditContext"] = serde_json::json!({ "operationId": "other" });
    let a = capture_wire(Route::Anthropic, &base).await.unwrap();
    let b = capture_wire(Route::Anthropic, &extra).await.unwrap();
    compare_wires(&a, &b).unwrap();

    let mut args = base;
    args["messages"] = serde_json::json!("not an array");
    assert!(capture_wire(Route::Anthropic, &args).await.is_err());
}

#[test]
fn route_names_are_matched_by_longest_prefix() {
    assert_eq!(
        Route::from_fixture_stem("openrouter-chat-claude-sceneA"),
        Some(Route::OpenrouterChatClaude)
    );
    assert_eq!(
        Route::from_fixture_stem("openrouter-chat-sceneA"),
        Some(Route::OpenrouterChat)
    );
    assert_eq!(
        Route::from_fixture_stem("openrouter-responses-sceneA"),
        Some(Route::OpenrouterResponses)
    );
    assert_eq!(
        Route::from_fixture_stem("openai-chat"),
        Some(Route::OpenaiChat)
    );
    assert_eq!(
        Route::from_fixture_stem("anthropic-x"),
        Some(Route::Anthropic)
    );
    assert_eq!(Route::from_fixture_stem("anthropicx"), None);
    assert_eq!(Route::from_fixture_stem("gemini-x"), None);
}

/// 写し（`WireArgs`）が napi の `AgentRequest` から外れていないこと（欄の名前の drift 検出）。
#[test]
fn wire_args_mirror_matches_napi_agent_request() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../electron/native/grimodex-node/src/lib.rs");
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("napi の lib.rs を読めない: {}: {error}", path.display()));
    let start = source
        .find("struct AgentRequest {")
        .expect("napi に struct AgentRequest が無い");
    let block = &source[start..];
    let block = &block[..block.find("\n}").expect("AgentRequest の閉じが無い")];
    let mut napi_keys: Vec<String> = block
        .lines()
        .skip(1)
        .filter_map(|line| {
            line.trim()
                .split_once(':')
                .map(|(name, _)| name.trim().to_string())
        })
        .filter(|name| !name.is_empty() && !name.starts_with("//"))
        .map(|name| {
            let mut camel = String::new();
            let mut upper = false;
            for ch in name.chars() {
                if ch == '_' {
                    upper = true;
                } else if upper {
                    camel.extend(ch.to_uppercase());
                    upper = false;
                } else {
                    camel.push(ch);
                }
            }
            camel
        })
        .collect();
    napi_keys.sort();
    let mut mirror: Vec<String> = READ_ARG_KEYS
        .iter()
        .chain(IGNORED_ARG_KEYS.iter())
        .map(|key| key.to_string())
        .collect();
    mirror.sort();
    assert_eq!(
        napi_keys, mirror,
        "napi の AgentRequest の欄と、この試験の写し（READ_ARG_KEYS／IGNORED_ARG_KEYS／WireArgs）が違う"
    );
}
