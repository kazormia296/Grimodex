use super::*;
use grimodex_db::ai_audit::AppendAiAuditEvent;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[derive(Clone, Default)]
struct RecordingAppender {
    events: Arc<Mutex<Vec<AppendAiAuditEvent>>>,
    attempts: Arc<Mutex<Vec<Vec<AppendAiAuditEvent>>>>,
    append_calls: Arc<AtomicUsize>,
    fail_on_append_call: Arc<AtomicUsize>,
    second_fail_on_append_call: Arc<AtomicUsize>,
    reply_loss_on_append_call: Arc<AtomicUsize>,
}

impl RecordingAppender {
    fn fail_once(&self) {
        self.fail_on_append_call(1);
    }

    fn fail_on_append_call(&self, call: usize) {
        self.append_calls.store(0, Ordering::SeqCst);
        self.fail_on_append_call.store(call, Ordering::SeqCst);
        self.second_fail_on_append_call.store(0, Ordering::SeqCst);
        self.reply_loss_on_append_call.store(0, Ordering::SeqCst);
    }

    fn fail_on_append_calls(&self, first: usize, second: usize) {
        self.append_calls.store(0, Ordering::SeqCst);
        self.fail_on_append_call.store(first, Ordering::SeqCst);
        self.second_fail_on_append_call
            .store(second, Ordering::SeqCst);
        self.reply_loss_on_append_call.store(0, Ordering::SeqCst);
    }

    fn lose_reply_on_append_call(&self, call: usize) {
        self.append_calls.store(0, Ordering::SeqCst);
        self.fail_on_append_call.store(0, Ordering::SeqCst);
        self.second_fail_on_append_call.store(0, Ordering::SeqCst);
        self.reply_loss_on_append_call.store(call, Ordering::SeqCst);
    }

    fn events(&self) -> Vec<AppendAiAuditEvent> {
        self.events.lock().unwrap().clone()
    }

    fn attempts(&self) -> Vec<Vec<AppendAiAuditEvent>> {
        self.attempts.lock().unwrap().clone()
    }
}

impl PostEffectAuditAppender for RecordingAppender {
    fn append(&self, _project_id: &str, events: &[AppendAiAuditEvent]) -> anyhow::Result<()> {
        let call = self.append_calls.fetch_add(1, Ordering::SeqCst) + 1;
        self.attempts.lock().unwrap().push(events.to_vec());
        if self.fail_on_append_call.load(Ordering::SeqCst) == call
            || self.second_fail_on_append_call.load(Ordering::SeqCst) == call
        {
            anyhow::bail!("injected audit append failure");
        }
        if self.reply_loss_on_append_call.load(Ordering::SeqCst) != 0 {
            let mut recorded = self.events.lock().unwrap();
            for event in events {
                if !recorded
                    .iter()
                    .any(|recorded_event| recorded_event.event_id == event.event_id)
                {
                    recorded.push(event.clone());
                }
            }
            if self.reply_loss_on_append_call.load(Ordering::SeqCst) == call {
                anyhow::bail!("injected audit append reply loss");
            }
        } else {
            self.events.lock().unwrap().extend_from_slice(events);
        }
        Ok(())
    }
}

#[derive(Clone)]
enum FakeResult {
    Success,
    SuccessCredentialLikeOutput,
    Error,
    ErrorWithSecretUrl,
    Pending,
    Panic,
    PrepareError,
}

type RecordedRequest = (String, Option<String>, String);

#[derive(Clone)]
struct RecordingAi {
    calls: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    result: FakeResult,
}

impl RecordingAi {
    fn new(result: FakeResult) -> Self {
        Self {
            calls: Arc::new(AtomicUsize::new(0)),
            requests: Arc::new(Mutex::new(Vec::new())),
            result,
        }
    }
}

impl PostEffectAiClient for RecordingAi {
    fn resolve_audit_route(&self, _request: &PostEffectAiRequest<'_>) -> PostEffectAiResolvedRoute {
        PostEffectAiResolvedRoute {
            provider: "openai-compatible".into(),
            model: "resolved-model".into(),
            api_variant: Some("chat-completions".into()),
            endpoint_id: Some("local-test".into()),
            endpoint_host: Some("127.0.0.1:1234".into()),
            ..Default::default()
        }
    }

    fn call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<PostEffectAiOutput>> + Send + 'a>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.requests.lock().unwrap().push((
            request.system_prompt.to_string(),
            request.codex_content.map(str::to_owned),
            request.scene_content.to_string(),
        ));
        Box::pin(async move {
            match self.result {
                FakeResult::Success => Ok(PostEffectAiOutput {
                    raw_response: "{\"reviews\":[]}".into(),
                    detected_model: "resolved-model".into(),
                }),
                FakeResult::SuccessCredentialLikeOutput => Ok(PostEffectAiOutput {
                    raw_response: r#"{"api_key":"fictional clue","token":"story token"}"#.into(),
                    detected_model: "resolved-model".into(),
                }),
                FakeResult::Error => anyhow::bail!("provider unavailable"),
                FakeResult::ErrorWithSecretUrl => anyhow::bail!(
                    "HTTP 401 (https://api.example.test/v1?api_key=super-secret): \
                     api_key=key-secret token=token-secret password=password-secret; \
                     Authorization: Bearer bearer-secret; Cookie: sid=cookie-secret"
                ),
                FakeResult::Pending => std::future::pending().await,
                FakeResult::Panic => panic!("injected provider panic"),
                FakeResult::PrepareError => panic!("prepare error must not dispatch"),
            }
        })
    }

    fn prepare_call<'a>(
        &'a self,
        request: PostEffectAiRequest<'a>,
    ) -> anyhow::Result<(PostEffectAiResolvedRoute, PostEffectAiDispatch<'a>)> {
        if matches!(&self.result, FakeResult::PrepareError) {
            anyhow::bail!("route resolution failed api_key=route-secret");
        }
        let mut route = self.resolve_audit_route(&request);
        let settings = grimodex_ai::AiSettings {
            provider: grimodex_ai::AiProvider::OpenaiCompatible,
            model: route.model.clone(),
            ..Default::default()
        };
        route.effective_request = Some(grimodex_ai::prepare_post_effect_request(
            &settings,
            request.system_prompt,
            request.codex_content,
            request.scene_content,
        )?);
        route.limitations.clear();
        let dispatch: PostEffectAiDispatch<'a> = Box::new(move || self.call(request));
        Ok((route, dispatch))
    }
}

fn context(scene_id: &str) -> PostEffectAuditContext {
    PostEffectAuditContext {
        project_id: "project-a".into(),
        operation_id: "run-a".into(),
        run_id: "run-a".into(),
        scene_id: scene_id.into(),
        effect_type: "review".into(),
        path_id: "post_effect_review".into(),
        scope_type: "scene".into(),
        scope_target_id: Some(scene_id.into()),
        prompt_version: "review_v1.1".into(),
        requested_model: "requested-model".into(),
        parent_execution_id: None,
        retry_of_execution_id: None,
    }
}

fn request<'a>(
    system_prompt: &'a str,
    codex_content: Option<&'a str>,
    scene_content: &'a str,
    role_override: &'a RoleProviderOverride,
) -> PostEffectAiRequest<'a> {
    PostEffectAiRequest {
        model_override: Some("override-model"),
        role_override,
        system_prompt,
        codex_content,
        scene_content,
    }
}

#[tokio::test]
async fn audit_records_exact_request_route_and_raw_response_before_returning() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride {
        provider: Some(AiProvider::OpenaiCompatible),
        api_variant: Some("chat-completions".into()),
        endpoint_id: Some("local-test".into()),
    };

    let output = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request(
            "system prompt exact\nline 2",
            Some("[{\"name\":\"Codex exact\"}]"),
            "scene text exact 📝",
            &prov,
        ),
    )
    .await
    .expect("AI call succeeds");

    assert_eq!(output.raw_response, "{\"reviews\":[]}");
    assert_eq!(ai.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        ai.requests.lock().unwrap().as_slice(),
        &[(
            "system prompt exact\nline 2".into(),
            Some("[{\"name\":\"Codex exact\"}]".into()),
            "scene text exact 📝".into(),
        )]
    );

    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec![
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded",
        ]
    );
    let prepared = &events[1].payload;
    assert_eq!(
        prepared["request"]["system_prompt"],
        "system prompt exact\nline 2"
    );
    assert_eq!(
        prepared["request"]["codex_content"],
        "[{\"name\":\"Codex exact\"}]"
    );
    assert_eq!(prepared["request"]["scene_content"], "scene text exact 📝");
    assert_eq!(
        prepared["request"]["body"],
        serde_json::json!({
            "model": "resolved-model",
            "messages": [
                { "role": "system", "content": "system prompt exact\nline 2" },
                {
                    "role": "user",
                    "content": "[Codex]\n[{\"name\":\"Codex exact\"}]\n\n[Scene]\nscene text exact 📝"
                }
            ]
        })
    );
    assert_eq!(prepared["request"]["wireRoute"], "chat_completions");
    assert_eq!(
        prepared["request"]["effectiveOutputTokenLimit"],
        serde_json::json!({
            "field": null,
            "value": null,
            "source": "provider_default",
            "omitted": true,
        })
    );
    assert_eq!(prepared["captureState"], "partial");
    assert_eq!(
        prepared["limitations"],
        serde_json::json!(["provider-default-output-token-limit-not-observable"])
    );
    assert_eq!(prepared["route"]["configured_model"], "requested-model");
    assert_eq!(prepared["route"]["requested_model"], "override-model");
    assert_eq!(prepared["route"]["model_override"], "override-model");
    assert_eq!(prepared["route"]["requested_provider"], "openai-compatible");
    assert_eq!(prepared["route"]["provider_override"], "openai-compatible");
    assert_eq!(prepared["route"]["resolved_model"], "resolved-model");
    assert_eq!(prepared["route"]["resolved_provider"], "openai-compatible");
    assert_eq!(prepared["route"]["endpoint_host"], "127.0.0.1:1234");
    assert_eq!(events[2].payload["dispatchBoundary"], "before_client_call");
    assert_eq!(events[2].payload["providerReceiptObserved"], false);
    assert_eq!(events[3].payload["raw_response"], "{\"reviews\":[]}");
}

#[test]
fn live_pseudo_comment_has_a_distinct_audit_path() {
    assert_eq!(
        post_effect_path_id("pseudo_comment", "pseudo_comment_live_v1.0"),
        "post_effect_live_pseudo_comment"
    );
    assert_eq!(
        post_effect_path_id("pseudo_comment", "pseudo_comment_v2.1"),
        "post_effect_pseudo_comment"
    );
}

#[test]
fn endpoint_and_provider_error_sanitizers_drop_query_secrets() {
    assert_eq!(
        normalized_endpoint_host("HTTPS://User:pass@API.Example.Test:8443/v1?q=secret#fragment"),
        Some("api.example.test:8443".into())
    );
    let sanitized = sanitize_provider_error(
        "HTTP 401 (https://user:pass@api.example.test/v1?api_key=super-secret): denied",
    );
    assert!(!sanitized.contains("super-secret"));
    assert!(!sanitized.contains("api_key="));
    assert!(sanitized.contains("https://api.example.test/v1"));

    for (source, secret) in [
        ("Authorization: Bearer bearer-secret", "bearer-secret"),
        ("api_key=key-secret", "key-secret"),
        ("token=token-secret", "token-secret"),
        ("password=password-secret", "password-secret"),
        (
            "OPENAI_API_KEY = \"quoted key secret\"",
            "quoted key secret",
        ),
        ("AWS_ACCESS_KEY_ID = 'access id secret'", "access id secret"),
        (
            "provider_private_key = \"private key secret\"",
            "private key secret",
        ),
        ("openaiAuth = 'auth alias secret'", "auth alias secret"),
        ("Cookie: sid=cookie-secret", "cookie-secret"),
        (
            "X-Api-Key: provider-header-secret",
            "provider-header-secret",
        ),
    ] {
        let sanitized = sanitize_provider_error(source);
        assert!(!sanitized.contains(secret), "source: {source}");
        assert!(
            sanitized.contains("[REDACTED:credential]"),
            "source: {source}"
        );
    }

    let quoted_json = r#"provider body {"api_key":"json-api-secret","Authorization":"Bearer json-auth-secret","cookie":"sid=json-cookie-secret","nested":{"accessToken":"json-token-secret","password":"json-password-secret","client_secret":"json-client-secret","AWS_ACCESS_KEY_ID":"json-access-id-secret","OPENAI_PRIVATE_KEY":"json-private-key-secret","providerAuth":"json-auth-alias-secret"},"model":"keep-model"}"#;
    let sanitized = sanitize_provider_error(quoted_json);
    for secret in [
        "json-api-secret",
        "json-auth-secret",
        "json-cookie-secret",
        "json-token-secret",
        "json-password-secret",
        "json-client-secret",
        "json-access-id-secret",
        "json-private-key-secret",
        "json-auth-alias-secret",
    ] {
        assert!(!sanitized.contains(secret));
    }
    assert!(sanitized.contains(r#""model":"keep-model""#));
}

#[tokio::test]
async fn credential_shaped_success_output_remains_exact_model_output() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::SuccessCredentialLikeOutput);
    let prov = RoleProviderOverride::default();

    let output = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect("AI call succeeds");

    assert_eq!(
        output.raw_response,
        r#"{"api_key":"fictional clue","token":"story token"}"#
    );
    let response = appender
        .events()
        .into_iter()
        .find(|event| event.event_type == "response.completed")
        .expect("response audit event");
    assert_eq!(response.payload["raw_response"], output.raw_response);
    assert!(!response
        .payload
        .to_string()
        .contains("[REDACTED:credential]"));
}

#[tokio::test]
async fn prepared_append_failure_blocks_ai_dispatch() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_on_append_calls(1, 2);
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender,
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect_err("audit failure must fail closed");

    assert!(error.to_string().contains("audit"));
    assert_eq!(ai.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn transient_prepared_reply_loss_retries_exact_batch_once_before_dispatch() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_once();
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride::default();

    call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect("prepared reply loss is recovered before dispatch");

    assert_eq!(ai.calls.load(Ordering::SeqCst), 1);
    let attempts = appender.attempts();
    assert_eq!(attempts[0].len(), 3);
    assert_eq!(attempts[0][0].event_id, attempts[1][0].event_id);
    assert_eq!(attempts[0][1].event_id, attempts[1][1].event_id);
    assert_eq!(attempts[0][2].event_id, attempts[1][2].event_id);
    assert_eq!(
        appender
            .events()
            .iter()
            .filter(|event| event.event_type == "request.prepared")
            .count(),
        1
    );
}

#[test]
fn cache_hit_non_execution_retry_is_exact_and_reports_missing_source_execution() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_once();
    append_post_effect_non_execution(
        appender.clone(),
        context("scene-a"),
        "execution.cache_hit",
        "completed_run_reused",
        None,
        serde_json::json!({ "inputHash": "hash-a" }),
    )
    .expect("cache-hit audit retry");

    let attempts = appender.attempts();
    assert_eq!(attempts[0][0].event_id, attempts[1][0].event_id);
    assert_eq!(attempts[0][1].event_id, attempts[1][1].event_id);
    let recorded = appender.events();
    assert_eq!(recorded[1].payload["captureState"], "partial");
    assert_eq!(
        recorded[1].payload["limitations"][0],
        "cache-source-execution-unavailable"
    );
    assert!(recorded[1].payload["relatedExecutionId"].is_null());
}

#[tokio::test]
async fn transient_completed_append_failure_retries_exact_raw_response_before_returning() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_on_append_call(2);
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride::default();

    let output = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect("terminal append retry succeeds");

    assert_eq!(output.raw_response, "{\"reviews\":[]}");
    assert_eq!(appender.append_calls.load(Ordering::SeqCst), 3);
    let events = appender.events();
    let responses = events
        .iter()
        .filter(|event| event.event_type == "response.completed")
        .collect::<Vec<_>>();
    assert_eq!(responses.len(), 1);
    assert_eq!(responses[0].payload["raw_response"], "{\"reviews\":[]}");
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "execution.succeeded")
            .count(),
        1
    );
}

#[tokio::test]
async fn provider_error_appends_terminal_failure() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::Error);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect_err("provider error");

    assert!(error.to_string().contains("provider unavailable"));
    let events = appender.events();
    assert_eq!(events.last().unwrap().event_type, "execution.failed");
    assert_eq!(events.last().unwrap().payload["phase"], "provider_call");
    assert_eq!(
        events.last().unwrap().payload["clientDispatchAttempted"],
        true
    );
    assert!(events.last().unwrap().payload["modelDispatched"].is_null());
    assert_eq!(
        events.last().unwrap().payload["providerReceiptObserved"],
        serde_json::Value::Null
    );
}

#[tokio::test]
async fn provider_failure_terminal_retries_the_exact_event_id() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_on_append_call(2);
    let ai = RecordingAi::new(FakeResult::Error);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect_err("provider error remains the result after audit retry");

    assert!(error.to_string().contains("provider unavailable"));
    assert_eq!(appender.append_calls.load(Ordering::SeqCst), 3);
    let attempts = appender.attempts();
    assert_eq!(attempts[1][0].event_id, attempts[2][0].event_id);
    assert_eq!(attempts[1][0].payload, attempts[2][0].payload);
}

#[tokio::test]
async fn route_preparation_failure_records_request_without_dispatch() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::PrepareError);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system exact", Some("codex exact"), "scene exact", &prov),
    )
    .await
    .expect_err("route preparation fails");

    assert!(!error.to_string().contains("route-secret"));
    assert_eq!(ai.calls.load(Ordering::SeqCst), 0);
    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        ["execution.started", "request.prepared", "execution.failed"]
    );
    assert_eq!(events[1].payload["captureState"], "partial");
    assert_eq!(
        events[1].payload["request"]["system_prompt"],
        "system exact"
    );
    assert_eq!(events[1].payload["route"]["resolutionState"], "failed");
    assert!(events[1].payload["request"]["body"].is_null());
    assert_eq!(
        events[1].payload["limitations"],
        serde_json::json!([
            "exact-effective-request-body-unavailable",
            "resolved-provider-route-unavailable"
        ])
    );
    assert!(events[1].payload["route"]["resolved_model"].is_null());
    assert_eq!(events[2].payload["phase"], "route_preparation");
    assert_eq!(events[2].payload["modelDispatched"], false);
}

#[tokio::test]
async fn provider_error_audit_does_not_persist_url_query_secrets() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::ErrorWithSecretUrl);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect_err("provider error");

    let returned_error = error.to_string();
    assert!(!returned_error.contains("super-secret"));
    assert!(returned_error.contains("[REDACTED:credential]"));

    let serialized = appender
        .events()
        .into_iter()
        .map(|event| event.payload.to_string())
        .collect::<String>();
    assert!(!serialized.contains("super-secret"));
    assert!(serialized.contains("[REDACTED:credential]"));
    for secret in [
        "key-secret",
        "token-secret",
        "password-secret",
        "bearer-secret",
        "cookie-secret",
    ] {
        assert!(!serialized.contains(secret));
    }

    let recorded_events = appender.events();
    let redaction = &recorded_events.last().expect("failure terminal").payload["redactions"][0];
    let keys = redaction
        .as_object()
        .expect("redaction object")
        .keys()
        .map(String::as_str)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        keys,
        [
            "category",
            "originalByteLength",
            "originalSha256",
            "path",
            "placeholder",
            "reversible",
            "ruleId",
        ]
        .into_iter()
        .collect()
    );
}

#[tokio::test]
async fn terminal_response_double_append_failure_falls_back_to_partial_fingerprint() {
    let appender = Arc::new(RecordingAppender::default());
    appender.fail_on_append_calls(2, 3);
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride::default();

    let error = call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system", None, "scene", &prov),
    )
    .await
    .expect_err("raw response audit cannot become durable");

    assert!(error.to_string().contains("bounded retry"));
    let events = appender.events();
    let fallback = events.last().expect("fallback terminal");
    assert_eq!(fallback.event_type, "execution.failed");
    assert_eq!(fallback.payload["phase"], "terminal_audit_append");
    assert_eq!(fallback.payload["captureState"], "partial");
    assert_eq!(
        fallback.payload["limitations"],
        serde_json::json!([
            "provider-default-output-token-limit-not-observable",
            "observable-response-not-durable"
        ])
    );
    assert_eq!(fallback.payload["observableResponseByteLength"], 14);
    assert_eq!(fallback.payload["rawResponsePersisted"], false);
    assert!(fallback.payload.get("raw_response").is_none());
}

#[tokio::test]
async fn dropping_in_flight_call_appends_cancelled_terminal() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::Pending);
    let prov = RoleProviderOverride::default();

    let timed_out = tokio::time::timeout(
        Duration::from_millis(10),
        call_post_effect_ai_with_appender(
            appender.clone(),
            &ai,
            context("scene-a"),
            request("system", None, "scene", &prov),
        ),
    )
    .await;

    assert!(timed_out.is_err());
    assert_eq!(
        appender.events().last().unwrap().event_type,
        "execution.cancelled"
    );
}

#[tokio::test]
async fn dropped_call_terminal_reply_loss_retries_the_exact_event_id() {
    let appender = Arc::new(RecordingAppender::default());
    // Prepared/dispatched is call 1. The Drop terminal commits on call 2 but
    // loses its reply; call 3 must reuse the exact event ID and be idempotent.
    appender.lose_reply_on_append_call(2);
    let ai = RecordingAi::new(FakeResult::Pending);
    let prov = RoleProviderOverride::default();

    let timed_out = tokio::time::timeout(
        Duration::from_millis(10),
        call_post_effect_ai_with_appender(
            appender.clone(),
            &ai,
            context("scene-a"),
            request("system", None, "scene", &prov),
        ),
    )
    .await;

    assert!(timed_out.is_err());
    assert_eq!(appender.append_calls.load(Ordering::SeqCst), 3);
    let attempts = appender.attempts();
    assert_eq!(attempts[1][0].event_id, attempts[2][0].event_id);
    assert_eq!(attempts[1][0].payload, attempts[2][0].payload);
    let terminals = appender
        .events()
        .into_iter()
        .filter(|event| event.event_type == "execution.cancelled")
        .collect::<Vec<_>>();
    assert_eq!(terminals.len(), 1);
    assert_eq!(terminals[0].payload["phase"], "in_flight_future_dropped");
}

#[tokio::test]
async fn provider_future_panic_appends_failed_terminal() {
    let appender = Arc::new(RecordingAppender::default());
    let task_appender = appender.clone();
    let task = tokio::spawn(async move {
        let ai = RecordingAi::new(FakeResult::Panic);
        let prov = RoleProviderOverride::default();
        call_post_effect_ai_with_appender(
            task_appender,
            &ai,
            context("scene-a"),
            request("system", None, "scene", &prov),
        )
        .await
    });

    let join_error = task.await.expect_err("provider future panics");
    assert!(join_error.is_panic());
    let terminal = appender.events().pop().expect("panic terminal");
    assert_eq!(terminal.event_type, "execution.failed");
    assert_eq!(terminal.payload["phase"], "panic_unwind");
    assert!(terminal.payload["modelDispatched"].is_null());
}

#[tokio::test]
async fn separate_scenes_receive_distinct_execution_ids() {
    let appender = Arc::new(RecordingAppender::default());
    let ai = RecordingAi::new(FakeResult::Success);
    let prov = RoleProviderOverride::default();

    call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-a"),
        request("system-a", None, "scene-a", &prov),
    )
    .await
    .unwrap();
    call_post_effect_ai_with_appender(
        appender.clone(),
        &ai,
        context("scene-b"),
        request("system-b", None, "scene-b", &prov),
    )
    .await
    .unwrap();

    let started = appender
        .events()
        .into_iter()
        .filter(|event| event.event_type == "execution.started")
        .collect::<Vec<_>>();
    assert_eq!(started.len(), 2);
    assert_ne!(started[0].execution_id, started[1].execution_id);
    assert_eq!(started[0].payload["sceneId"], "scene-a");
    assert_eq!(started[1].payload["sceneId"], "scene-b");
}
