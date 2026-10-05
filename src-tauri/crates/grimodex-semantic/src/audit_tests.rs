use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::anyhow;
use grimodex_db::ai_audit::AppendAiAuditEvent;
use serde_json::json;

use crate::audit::{
    embedding_output_payload, load_verified_model_artifact_identity, sha256_hex,
    SemanticAuditAppender, SemanticAuditContext, SemanticAuditSession, TokenizerIdentity,
};

#[derive(Default)]
struct RecordingAppender {
    calls: Mutex<Vec<(Option<String>, Vec<AppendAiAuditEvent>)>>,
    failures_remaining: AtomicUsize,
}

impl RecordingAppender {
    fn failing(times: usize) -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            failures_remaining: AtomicUsize::new(times),
        }
    }

    fn events(&self) -> Vec<AppendAiAuditEvent> {
        self.calls
            .lock()
            .expect("recording appender lock")
            .iter()
            .flat_map(|(_, events)| events.clone())
            .collect()
    }
}

impl SemanticAuditAppender for RecordingAppender {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.calls
            .lock()
            .expect("recording appender lock")
            .push((project_id.map(str::to_owned), events.to_vec()));
        if self
            .failures_remaining
            .try_update(Ordering::AcqRel, Ordering::Acquire, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(anyhow!("synthetic append failure"));
        }
        Ok(())
    }
}

fn context() -> SemanticAuditContext {
    SemanticAuditContext {
        project_id: Some("project-1".into()),
        operation_id: "operation-1".into(),
        parent_execution_id: None,
        path_id: "semantic_search".into(),
        inference_kind: "embedding.query".into(),
        model: json!({
            "modelId": "model@revision",
            "artifactSha256": "abc123",
            "engine": "onnx-runtime",
            "tokenizerIdentity": TokenizerIdentity::from_bytes(
                "tokenizer.json",
                b"default loaded tokenizer bytes",
            ),
        }),
        input: json!({
            "rawText": "灯台",
            "modelText": "検索クエリ: 灯台",
        }),
        metadata: json!({ "domain": "scene" }),
    }
}

#[test]
fn token_limit_skip_is_durable_and_never_claims_onnx_success() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session = SemanticAuditSession::prepare(appender.clone(), context())
        .expect("start exact-input audit before tokenizer");
    session
        .skip_before_onnx(
            "document-token-limit",
            json!({
                "actualTokens": 513, "maximumTokens": 512,
            }),
        )
        .expect("durable typed non-execution");
    drop(session);
    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event.event_type == "execution.skipped")
            .count(),
        1
    );
    assert!(!events
        .iter()
        .any(|event| event.event_type == "execution.succeeded"));
    let skipped = events.last().expect("terminal skip");
    assert_eq!(skipped.payload["onnxSessionRunObserved"], false);
    assert_eq!(skipped.payload["modelDispatched"], false);
    assert_eq!(skipped.payload["reason"], "document-token-limit");
}

#[test]
fn token_limit_terminal_audit_failure_is_not_a_successful_skip() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::prepare(appender.clone(), context()).expect("start durable audit");
    appender.failures_remaining.store(2, Ordering::Release);
    assert!(session
        .skip_before_onnx("document-token-limit", json!({}))
        .is_err());
}

#[test]
fn model_artifact_identity_tracks_exact_cold_load_bytes() {
    let path = std::env::temp_dir().join(format!(
        "grimodex-semantic-artifact-{}-{}.onnx",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let bytes = b"exact ONNX fixture bytes";
    std::fs::write(&path, bytes).expect("write artifact fixture");
    let expected_sha256 = sha256_hex(bytes);

    let identity = load_verified_model_artifact_identity(&path, &expected_sha256)
        .expect("hash exact artifact bytes");
    assert_eq!(identity.identity_version, 1);
    assert_eq!(identity.fingerprint_algorithm, "sha256");
    assert_eq!(
        identity.file_name,
        path.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(identity.sha256, expected_sha256);
    assert_eq!(identity.byte_length, bytes.len() as u64);
    let _ = std::fs::remove_file(path);
}

fn context_awaiting_effective_tokenizer() -> SemanticAuditContext {
    let mut audit_context = context();
    audit_context
        .model
        .as_object_mut()
        .expect("model object")
        .remove("tokenizerIdentity");
    audit_context.model["tokenizerIdentityStatus"] = json!("pending-effective-receipt");
    audit_context
}

fn prepared_event_for_tokenizer_bytes(bytes: &[u8]) -> AppendAiAuditEvent {
    let appender = Arc::new(RecordingAppender::default());
    let mut audit_context = context();
    audit_context.model["tokenizerIdentity"] =
        serde_json::to_value(TokenizerIdentity::from_bytes("tokenizer.json", bytes))
            .expect("serialize tokenizer identity");
    let session =
        SemanticAuditSession::start(appender.clone(), audit_context).expect("start semantic audit");
    drop(session);

    appender
        .events()
        .into_iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("prepared event")
}

#[test]
fn recorded_tokenizer_fingerprint_tracks_exact_loaded_bytes() {
    let first_bytes = br#"{"version":"1.0","model":{"type":"WordLevel"}}"#;
    let changed_bytes = br#"{"version":"1.0", "model":{"type":"WordLevel"}}"#;

    let first = prepared_event_for_tokenizer_bytes(first_bytes);
    let repeated = prepared_event_for_tokenizer_bytes(first_bytes);
    let changed = prepared_event_for_tokenizer_bytes(changed_bytes);

    assert_eq!(
        first.payload["model"]["tokenizerIdentity"],
        repeated.payload["model"]["tokenizerIdentity"]
    );
    assert_ne!(
        first.payload["model"]["tokenizerIdentity"]["sha256"],
        changed.payload["model"]["tokenizerIdentity"]["sha256"]
    );
    assert_eq!(
        first.payload["model"]["tokenizerIdentity"]["identityVersion"],
        1
    );
    assert_eq!(
        first.payload["model"]["tokenizerIdentity"]["fingerprintAlgorithm"],
        "sha256"
    );
    assert_eq!(
        first.payload["model"]["tokenizerIdentity"]["fileName"],
        "tokenizer.json"
    );
    assert_eq!(
        first.payload["model"]["tokenizerIdentity"]["byteLength"],
        first_bytes.len()
    );
}

#[test]
fn semantic_request_declares_the_exact_tokenization_capture_boundary() {
    let prepared = prepared_event_for_tokenizer_bytes(b"exact tokenizer bytes");
    let capture = &prepared.payload["tokenizationCapture"];
    let limitations = prepared.payload["limitations"]
        .as_array()
        .expect("semantic limitations array");

    assert_eq!(prepared.payload["captureState"], "partial");
    assert_eq!(capture["rawSourceText"], "retained-exactly");
    assert_eq!(
        capture["modelVisibleText"],
        "retained-exactly-before-tokenization"
    );
    assert_eq!(capture["realizedTokenIds"], "not-retained");
    assert_eq!(capture["specialTokenExpansion"], "not-retained");
    assert_eq!(capture["postTruncationTokenSequence"], "not-retained");
    for limitation in [
        "realized-token-ids-not-retained",
        "special-token-expansion-not-retained",
        "post-truncation-token-sequence-not-retained",
        "raw-source-and-model-visible-text-retained-exactly",
    ] {
        assert!(
            limitations.iter().any(|value| value == limitation),
            "missing limitation {limitation}"
        );
    }
    assert_eq!(prepared.payload["input"]["rawText"], "灯台");
    assert_eq!(prepared.payload["input"]["modelText"], "検索クエリ: 灯台");
}

#[test]
fn preparation_failure_is_terminally_recorded_after_the_initial_request() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context_awaiting_effective_tokenizer())
            .expect("start semantic audit");

    let error = session
        .fail_preparation::<()>(anyhow!("tokenizer load failed"))
        .expect_err("preparation must fail");

    assert!(error.to_string().contains("tokenizer load failed"));
    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "execution.failed",
        ]
    );
    assert_eq!(events[1].payload["input"]["rawText"], "灯台");
    assert_eq!(
        events[3].payload["phase"],
        "local-inference-artifact-preparation"
    );
    assert_eq!(events[3].payload["modelDispatched"], false);
    assert_eq!(events[3].payload["onnxSessionRunObserved"], false);
}

#[test]
fn actual_tokenizer_receipt_is_durable_before_onnx_inference() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context_awaiting_effective_tokenizer())
            .expect("start semantic audit");
    let actual_identity =
        TokenizerIdentity::from_bytes("tokenizer.json", b"actual loaded tokenizer bytes");

    session
        .record_effective_model_before_inference(json!({
            "modelId": "model@revision",
            "artifactSha256": "abc123",
            "tokenizerIdentity": actual_identity,
        }))
        .expect("append effective tokenizer receipt");

    let appender_during_inference = Arc::clone(&appender);
    session
        .dispatch_and_run(
            move || {
                let events = appender_during_inference.events();
                let effective = events
                    .iter()
                    .rev()
                    .find(|event| {
                        event.event_type == "request.prepared"
                            && event.payload["requestStage"] == "effective-local-artifacts"
                    })
                    .expect("effective receipt must be durable before inference");
                assert_eq!(
                    effective.payload["model"]["tokenizerIdentity"]["sha256"],
                    TokenizerIdentity::from_bytes(
                        "tokenizer.json",
                        b"actual loaded tokenizer bytes"
                    )
                    .sha256
                );
                Ok(vec![0.5_f32])
            },
            |embedding| embedding_output_payload(embedding),
        )
        .expect("inference after effective receipt");

    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "request.prepared",
            "response.completed",
            "execution.succeeded",
        ]
    );
    assert_eq!(events[3].payload["captureState"], "partial");
    assert_eq!(
        events[3].payload["receiptBoundary"],
        "after-local-artifact-load-before-tokenization-and-onnx-run"
    );
}

#[test]
fn missing_effective_tokenizer_receipt_fails_closed_before_inference() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context_awaiting_effective_tokenizer())
            .expect("start semantic audit");
    let inference_calls = AtomicUsize::new(0);

    let error = session
        .dispatch_and_run(
            || {
                inference_calls.fetch_add(1, Ordering::Relaxed);
                Ok(vec![0.5_f32])
            },
            |embedding| embedding_output_payload(embedding),
        )
        .expect_err("missing effective receipt must block inference");

    assert!(error
        .to_string()
        .contains("effective tokenizer identity was not recorded"));
    assert_eq!(inference_calls.load(Ordering::Relaxed), 0);
    let events = appender.events();
    assert_eq!(
        events.last().expect("terminal").event_type,
        "execution.failed"
    );
    assert_eq!(
        events.last().expect("terminal").payload["phase"],
        "local-inference-artifact-preparation"
    );
}

#[test]
fn effective_receipt_append_failure_cannot_fall_through_to_inference() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context_awaiting_effective_tokenizer())
            .expect("start semantic audit");
    appender.failures_remaining.store(2, Ordering::Release);
    let receipt_error = session
        .record_effective_model_before_inference(json!({
            "modelId": "model@revision",
            "tokenizerIdentity": TokenizerIdentity::from_bytes(
                "tokenizer.json",
                b"actual loaded tokenizer bytes",
            ),
        }))
        .expect_err("effective receipt append must fail");
    assert!(receipt_error
        .to_string()
        .contains("append effective semantic model identity"));

    let inference_calls = AtomicUsize::new(0);
    let dispatch_error = session
        .dispatch_and_run(
            || {
                inference_calls.fetch_add(1, Ordering::Relaxed);
                Ok(vec![0.5_f32])
            },
            |embedding| embedding_output_payload(embedding),
        )
        .expect_err("failed receipt append must still block inference");
    assert!(dispatch_error
        .to_string()
        .contains("effective tokenizer identity was not recorded"));
    assert_eq!(inference_calls.load(Ordering::Relaxed), 0);
}

#[test]
fn exact_input_and_model_are_durable_before_inference() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context()).expect("start semantic audit");
    let inference_calls = AtomicUsize::new(0);
    let output = session
        .dispatch_and_run(
            || {
                inference_calls.fetch_add(1, Ordering::Relaxed);
                Ok(vec![0.25_f32, -0.5_f32])
            },
            |embedding| embedding_output_payload(embedding),
        )
        .expect("run semantic inference");

    assert_eq!(output, vec![0.25, -0.5]);
    assert_eq!(inference_calls.load(Ordering::Relaxed), 1);
    let events = appender.events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        [
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded",
        ]
    );
    let prepared = &events[1].payload;
    assert_eq!(prepared["credentialsExcluded"], true);
    assert_eq!(prepared["input"]["rawText"], "灯台");
    assert_eq!(prepared["input"]["modelText"], "検索クエリ: 灯台");
    assert_eq!(prepared["model"]["modelId"], "model@revision");
    assert_eq!(events[3].payload["embeddingDim"], 2);
    assert_eq!(events[3].payload["captureState"], "partial");
    assert_eq!(events[3].payload["rawEmbeddingOmitted"], true);
    assert_eq!(events[2].payload["localPipelineEntered"], false);
    assert_eq!(events[4].payload["onnxResultObserved"], true);
    let calls = appender.calls.lock().expect("recording appender lock");
    assert_eq!(
        calls.len(),
        2,
        "one embedding uses two durable transactions"
    );
    assert_eq!(calls[0].1.len(), 3);
    assert_eq!(calls[1].1.len(), 2);
}

#[test]
fn start_append_failure_blocks_inference() {
    let appender = Arc::new(RecordingAppender::failing(2));
    let inference_calls = AtomicUsize::new(0);
    let error = SemanticAuditSession::start(appender, context())
        .err()
        .expect("start append must fail");

    assert!(error
        .to_string()
        .contains("append semantic start/prepared/dispatched"));
    assert_eq!(inference_calls.load(Ordering::Relaxed), 0);
}

#[test]
fn completed_output_append_retries_the_exact_terminal_batch() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context()).expect("start semantic audit");
    appender.failures_remaining.store(1, Ordering::Release);

    session
        .dispatch_and_run(|| Ok(vec![1.0_f32]), |_| json!({ "value": 1 }))
        .expect("terminal retry succeeds");

    let calls = appender.calls.lock().expect("recording appender lock");
    assert_eq!(calls.len(), 3);
    assert_eq!(calls[1].1.len(), 2);
    assert_eq!(calls[1].1[0].event_id, calls[2].1[0].event_id);
    assert_eq!(calls[1].1[1].event_id, calls[2].1[1].event_id);
    assert_eq!(calls[1].1[0].payload, calls[2].1[0].payload);
}

#[test]
fn inference_error_records_unknown_onnx_dispatch_facts() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context()).expect("start semantic audit");
    let error = session
        .dispatch_and_run::<Vec<f32>>(|| Err(anyhow!("synthetic inference error")), |_| json!({}))
        .expect_err("inference must fail");

    assert!(error.to_string().contains("synthetic inference error"));
    let events = appender.events();
    let failed = events
        .iter()
        .find(|event| event.event_type == "execution.failed")
        .expect("failed terminal");
    assert_eq!(failed.payload["modelDispatched"], serde_json::Value::Null);
    assert_eq!(
        failed.payload["onnxSessionRunObserved"],
        serde_json::Value::Null
    );
}

#[test]
fn local_inference_error_redacts_credentials_and_url_queries() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context()).expect("start semantic audit");
    let error = session
        .dispatch_and_run::<Vec<f32>>(
            || {
                Err(anyhow!(
                    "{}",
                    r#"load https://user:pass@example.test/model?api_key=url-secret failed token=local-secret OPENAI_API_KEY = "quoted key secret" AWS_ACCESS_KEY_ID = 'access id secret' provider_private_key = "private key secret" openaiAuth = 'auth alias secret' diagnostic={"api_key":"json-api-secret","Authorization":"Bearer json-auth-secret","cookie":"sid=json-cookie-secret","nested":{"accessToken":"json-token-secret","password":"json-password-secret","client_secret":"json-client-secret","AWS_ACCESS_KEY_ID":"json-access-id-secret","OPENAI_PRIVATE_KEY":"json-private-key-secret","providerAuth":"json-auth-alias-secret"},"model":"keep-model"}"#
                ))
            },
            |_| json!({}),
        )
        .expect_err("inference must fail");

    assert!(!error.to_string().contains("url-secret"));
    assert!(!error.to_string().contains("local-secret"));
    for secret in [
        "json-api-secret",
        "json-auth-secret",
        "json-cookie-secret",
        "json-token-secret",
        "json-password-secret",
        "json-client-secret",
        "quoted key secret",
        "access id secret",
        "private key secret",
        "auth alias secret",
        "json-access-id-secret",
        "json-private-key-secret",
        "json-auth-alias-secret",
    ] {
        assert!(!error.to_string().contains(secret));
    }
    let events = appender.events();
    let failed = events
        .iter()
        .find(|event| event.event_type == "execution.failed")
        .expect("failure terminal");
    assert_eq!(failed.payload["captureState"], "redacted");
    assert_eq!(failed.payload["redactions"][0]["category"], "credential");
    assert!(failed.payload["error"]["message"].as_str().is_some());
    assert!(failed.payload["error"]["message"]
        .as_str()
        .is_some_and(|message| message.contains(r#""model":"keep-model""#)));
}

#[test]
fn credential_shaped_semantic_output_is_not_sanitized() {
    let appender = Arc::new(RecordingAppender::default());
    let mut session =
        SemanticAuditSession::start(appender.clone(), context()).expect("start semantic audit");
    let output = json!({
        "api_key": "fictional clue",
        "token": "story token",
    });

    let returned = session
        .dispatch_and_run(|| Ok(output.clone()), |result| result.clone())
        .expect("semantic inference succeeds");
    assert_eq!(returned, output);
    let response = appender
        .events()
        .into_iter()
        .find(|event| event.event_type == "response.completed")
        .expect("response audit event");
    assert_eq!(response.payload["api_key"], "fictional clue");
    assert_eq!(response.payload["token"], "story token");
    assert!(!response
        .payload
        .to_string()
        .contains("[REDACTED:credential]"));
}

// AI audit path: semantic_search
#[test]
fn ai_audit_path_semantic_search_records_exact_query() {
    let appender = Arc::new(RecordingAppender::default());
    let mut query_context = context();
    query_context.path_id = "semantic_search".into();
    query_context.input = json!({
        "rawText": "exact query",
        "modelText": "query: exact query",
    });
    let session =
        SemanticAuditSession::start(appender.clone(), query_context).expect("start query audit");
    drop(session);

    let prepared = appender
        .events()
        .into_iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("prepared query");
    assert_eq!(prepared.path_id, "semantic_search");
    assert_eq!(prepared.payload["input"]["modelText"], "query: exact query");
}

// AI audit path: semantic_embedding_index
#[test]
fn ai_audit_path_semantic_embedding_index_records_exact_document() {
    let appender = Arc::new(RecordingAppender::default());
    let mut document_context = context();
    document_context.path_id = "semantic_embedding_index".into();
    document_context.inference_kind = "embedding.document".into();
    document_context.input = json!({
        "rawText": "exact scene chunk",
        "modelText": "document: exact scene chunk",
    });
    let session = SemanticAuditSession::start(appender.clone(), document_context)
        .expect("start document audit");
    drop(session);

    let prepared = appender
        .events()
        .into_iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("prepared document");
    assert_eq!(prepared.path_id, "semantic_embedding_index");
    assert_eq!(
        prepared.payload["input"]["modelText"],
        "document: exact scene chunk"
    );
}

fn assert_reranker_path_records_exact_pairs_and_scores(path_id: &str) {
    let appender = Arc::new(RecordingAppender::default());
    let mut reranker_context = context();
    reranker_context.path_id = path_id.into();
    reranker_context.inference_kind = "reranker.cross-encoder".into();
    reranker_context.input = json!({
        "userMessage": "exact user",
        "sceneTail": "exact tail",
        "normalizedQuery": "exact user\nexact tail",
        "candidates": [{ "candidateId": "scene-a:0:10", "text": "exact candidate" }],
    });
    let mut session = SemanticAuditSession::start(appender.clone(), reranker_context)
        .expect("start reranker audit");
    session
        .dispatch_and_run(
            || Ok(json!({ "scores": [{ "candidateId": "scene-a:0:10", "score": 1.25 }] })),
            Clone::clone,
        )
        .expect("reranker inference");

    let events = appender.events();
    let prepared = events
        .iter()
        .find(|event| event.event_type == "request.prepared")
        .expect("prepared reranker");
    let completed = events
        .iter()
        .find(|event| event.event_type == "response.completed")
        .expect("completed reranker");
    assert_eq!(prepared.path_id, path_id);
    assert_eq!(
        prepared.payload["input"]["normalizedQuery"],
        "exact user\nexact tail"
    );
    assert_eq!(
        prepared.payload["input"]["candidates"][0]["text"],
        "exact candidate"
    );
    assert_eq!(completed.payload["scores"][0]["score"], 1.25);
    assert_eq!(completed.payload["captureState"], "complete");
}

// AI audit path: semantic_reranker
#[test]
fn ai_audit_path_semantic_reranker_records_exact_pairs_and_scores() {
    assert_reranker_path_records_exact_pairs_and_scores("semantic_reranker");
}

// AI audit path: semantic_reranker_shadow
#[test]
fn ai_audit_path_semantic_reranker_shadow_records_exact_pairs_and_scores() {
    assert_reranker_path_records_exact_pairs_and_scores("semantic_reranker_shadow");
}

#[test]
fn production_embedding_entrypoints_cannot_bypass_the_audited_wrapper() {
    let runtime = include_str!("runtime.rs");
    assert_eq!(runtime.matches("|| embedder.embed_query(").count(), 4);
    assert_eq!(runtime.matches("|| embedder.embed_document(").count(), 4);
    assert_eq!(
        runtime.matches("audited_embedding(").count(),
        9,
        "one helper definition plus every 4 search and 4 index inference call"
    );
    assert!(!runtime.contains("Ok((embedder.embed_query("));

    for source in [
        include_str!("index.rs"),
        include_str!("codex_index.rs"),
        include_str!("events_index.rs"),
        include_str!("chat_index.rs"),
    ] {
        for direct_helper in [
            "pub fn embed_scene_payloads(",
            "pub fn embed_scene_payloads_cancellable(",
            "pub fn index_scene(",
            "pub fn embed_codex_text(",
            "pub fn embed_event_text(",
            "pub fn embed_chat_text(",
        ] {
            if let Some(offset) = source.find(direct_helper) {
                let guard = source[..offset]
                    .lines()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join("\n");
                assert!(
                    guard.contains("cfg(all(feature = \"semantic-embedding\", test))"),
                    "unaudited helper must be test-only: {direct_helper}"
                );
            }
        }
    }
}
