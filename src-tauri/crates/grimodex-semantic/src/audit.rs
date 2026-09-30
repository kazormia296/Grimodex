//! Durable audit boundary for local semantic model inference.
//!
//! The ledger write happens before control enters the tokenizer/ONNX pipeline.
//! A failed start or dispatch append therefore fails closed: no model inference
//! is allowed without a durable exact-input record. Numerical embedding vectors
//! are represented by dimension + a byte-stable SHA-256 fingerprint; reranker
//! callers can persist their complete score payload.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use grimodex_db::ai_audit::{sanitize_diagnostic_credentials, AppendAiAuditEvent};
use grimodex_db::Database;
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub const TOKENIZER_IDENTITY_VERSION: u32 = 1;
pub const MODEL_ARTIFACT_IDENTITY_VERSION: u32 = 1;

/// Byte-level identity of the exact ONNX artifact opened by the inference
/// runtime. The expected specification hash is only a pin; this identity is
/// calculated from the file that will actually be committed into ORT.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelArtifactIdentity {
    pub identity_version: u32,
    pub fingerprint_algorithm: &'static str,
    pub file_name: String,
    pub sha256: String,
    pub byte_length: u64,
}

pub fn load_verified_model_artifact_identity(
    model_path: &Path,
    expected_sha256: &str,
) -> anyhow::Result<ModelArtifactIdentity> {
    let file = File::open(model_path)
        .with_context(|| format!("failed to open ONNX model at {model_path:?}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .with_context(|| format!("failed to hash ONNX model at {model_path:?}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        byte_length = byte_length.saturating_add(read as u64);
    }
    let sha256 = hex::encode(hasher.finalize());
    anyhow::ensure!(
        sha256 == expected_sha256,
        "ONNX artifact sha256 mismatch: expected {expected_sha256}, actual {sha256}"
    );
    Ok(ModelArtifactIdentity {
        identity_version: MODEL_ARTIFACT_IDENTITY_VERSION,
        fingerprint_algorithm: "sha256",
        file_name: model_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("model.onnx")
            .to_string(),
        sha256,
        byte_length,
    })
}

/// Byte-level identity of the exact `tokenizer.json` parsed by the inference
/// runtime. This intentionally fingerprints the source bytes rather than a
/// re-serialized `Tokenizer`, because JSON whitespace and any otherwise
/// semantically ignored fields are still part of the loaded artifact.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenizerIdentity {
    pub identity_version: u32,
    pub fingerprint_algorithm: &'static str,
    pub file_name: String,
    pub sha256: String,
    pub byte_length: usize,
}

impl TokenizerIdentity {
    pub fn from_bytes(file_name: impl Into<String>, bytes: &[u8]) -> Self {
        Self {
            identity_version: TOKENIZER_IDENTITY_VERSION,
            fingerprint_algorithm: "sha256",
            file_name: file_name.into(),
            sha256: sha256_hex(bytes),
            byte_length: bytes.len(),
        }
    }
}

#[cfg(feature = "semantic-embedding")]
pub fn parse_tokenizer_with_identity(
    file_name: &str,
    bytes: &[u8],
) -> anyhow::Result<(tokenizers::Tokenizer, TokenizerIdentity)> {
    let identity = TokenizerIdentity::from_bytes(file_name, bytes);
    let tokenizer = tokenizers::Tokenizer::from_bytes(bytes)
        .map_err(|error| anyhow::anyhow!("failed to parse tokenizer source bytes: {error}"))?;
    Ok((tokenizer, identity))
}

#[cfg(feature = "semantic-embedding")]
pub fn load_tokenizer_with_identity(
    tokenizer_path: &std::path::Path,
) -> anyhow::Result<(tokenizers::Tokenizer, TokenizerIdentity)> {
    let bytes = std::fs::read(tokenizer_path)
        .with_context(|| format!("failed to read tokenizer at {tokenizer_path:?}"))?;
    parse_tokenizer_with_identity(
        tokenizer_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("tokenizer.json"),
        &bytes,
    )
    .with_context(|| format!("failed to load tokenizer at {tokenizer_path:?}"))
}

pub trait SemanticAuditAppender: Send + Sync + 'static {
    fn append(&self, project_id: Option<&str>, events: &[AppendAiAuditEvent])
        -> anyhow::Result<()>;
}

impl SemanticAuditAppender for Database {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

impl SemanticAuditAppender for grimodex_db::WorkspaceAuthority {
    fn append(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<()> {
        self.db()
            .append_ai_audit_events_for_scope(project_id, events)
            .map(|_| ())
    }
}

#[derive(Clone, Debug)]
pub struct SemanticAuditContext {
    pub project_id: Option<String>,
    pub operation_id: String,
    pub parent_execution_id: Option<String>,
    pub path_id: String,
    pub inference_kind: String,
    pub model: Value,
    pub input: Value,
    pub metadata: Value,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionState {
    Prepared,
    Dispatched,
    Terminal,
}

pub struct SemanticAuditSession {
    appender: Arc<dyn SemanticAuditAppender>,
    context: SemanticAuditContext,
    execution_id: String,
    state: SessionState,
    effective_model_recorded: bool,
    requires_effective_model_receipt: bool,
}

impl SemanticAuditSession {
    pub fn start(
        appender: Arc<dyn SemanticAuditAppender>,
        context: SemanticAuditContext,
    ) -> anyhow::Result<Self> {
        Self::start_with_dispatch(appender, context, true)
    }

    /// Make the exact input durable while retaining a legal pre-dispatch skip
    /// boundary for complete document token-budget validation.
    pub fn prepare(
        appender: Arc<dyn SemanticAuditAppender>,
        context: SemanticAuditContext,
    ) -> anyhow::Result<Self> {
        Self::start_with_dispatch(appender, context, false)
    }

    fn start_with_dispatch(
        appender: Arc<dyn SemanticAuditAppender>,
        context: SemanticAuditContext,
        dispatch: bool,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !context.operation_id.trim().is_empty(),
            "semantic audit operationId is required"
        );
        anyhow::ensure!(
            !context.path_id.trim().is_empty(),
            "semantic audit pathId is required"
        );
        anyhow::ensure!(
            !context.inference_kind.trim().is_empty(),
            "semantic audit inferenceKind is required"
        );
        let requires_effective_model_receipt = !has_valid_tokenizer_identity(&context.model);
        let execution_id = Uuid::new_v4().to_string();
        let started = event(
            &context,
            &execution_id,
            "execution.started",
            json!({
                "captureState": "complete",
                "executionMode": "local-native",
                "modelDispatched": false,
            }),
        );
        let prepared = event(
            &context,
            &execution_id,
            "request.prepared",
            json!({
                "captureState": "partial",
                "credentialsExcluded": true,
                "model": context.model.clone(),
                "input": context.input.clone(),
                "requestStage": "initial-observable-request",
                "tokenizationCapture": tokenization_capture(),
                "limitations": tokenization_limitations(),
            }),
        );
        let dispatched = event(
            &context,
            &execution_id,
            "request.dispatched",
            json!({
                "captureState": "complete",
                "dispatchBoundary": "immediately-before-local-pipeline-call",
                "localPipelineEntered": false,
                "modelDispatched": null,
                "onnxSessionRunObserved": null,
            }),
        );
        let mut initial = vec![started, prepared];
        if dispatch {
            initial.push(dispatched);
        }
        append_exact_with_retry(appender.as_ref(), context.project_id.as_deref(), &initial)
            .context("append semantic start/prepared/dispatched before inference")?;
        Ok(Self {
            appender,
            context,
            execution_id,
            state: if dispatch {
                SessionState::Dispatched
            } else {
                SessionState::Prepared
            },
            effective_model_recorded: false,
            requires_effective_model_receipt,
        })
    }

    pub fn execution_id(&self) -> &str {
        &self.execution_id
    }

    /// Call only after complete input tokenization succeeds and immediately
    /// before consuming that same Encoding through the ONNX pipeline.
    pub fn dispatch_prepared(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state == SessionState::Prepared,
            "semantic audit session is not awaiting pre-dispatch validation"
        );
        let dispatched = event(
            &self.context,
            &self.execution_id,
            "request.dispatched",
            json!({
                "captureState": "complete",
                "dispatchBoundary": "immediately-before-onnx-inference",
                "completeInputPreflightPassed": true,
                "modelDispatched": null,
                "onnxSessionRunObserved": null,
            }),
        );
        append_exact_with_retry(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[dispatched],
        )
        .context("append semantic dispatch after complete-input preflight")?;
        self.state = SessionState::Dispatched;
        Ok(())
    }

    /// Complete a checked non-execution after the exact input was made durable.
    /// The caller must use this only before entering ORT. A failed terminal
    /// append is an error and cannot be reported as a successful typed skip.
    pub fn skip_before_onnx(&mut self, reason: &str, details: Value) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state == SessionState::Prepared,
            "semantic audit session is not awaiting pre-dispatch validation"
        );
        let skipped = event(
            &self.context,
            &self.execution_id,
            "execution.skipped",
            json!({
                "captureState": "complete",
                "reason": reason,
                "details": details,
                "phase": "before-onnx",
                "modelDispatched": false,
                "onnxSessionRunObserved": false,
            }),
        );
        let result = append_exact_with_retry(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[skipped],
        );
        self.state = SessionState::Terminal;
        result.context("append semantic non-execution before returning typed skip")
    }

    /// Append the identity of artifacts that were actually loaded after the
    /// initial request was made durable, but before tokenization and ONNX
    /// `Session::run`. This second prepared event is intentionally ordered after
    /// the local-pipeline dispatch boundary so load failures remain terminally
    /// observable without claiming an expected manifest is the loaded tokenizer.
    pub fn record_effective_model_before_inference(
        &mut self,
        actual_model: Value,
    ) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.state == SessionState::Dispatched,
            "semantic audit session is not awaiting inference"
        );
        anyhow::ensure!(
            !self.effective_model_recorded,
            "semantic effective model receipt was already recorded"
        );
        anyhow::ensure!(
            has_valid_tokenizer_identity(&actual_model),
            "semantic effective model receipt requires a valid tokenizerIdentity"
        );
        let prepared = event(
            &self.context,
            &self.execution_id,
            "request.prepared",
            json!({
                "captureState": "partial",
                "credentialsExcluded": true,
                "effectiveRequestReceipt": true,
                "requestStage": "effective-local-artifacts",
                "receiptBoundary": "after-local-artifact-load-before-tokenization-and-onnx-run",
                "model": actual_model.clone(),
                "input": self.context.input.clone(),
                "tokenizationCapture": tokenization_capture(),
                "limitations": tokenization_limitations(),
            }),
        );
        append_exact_with_retry(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[prepared],
        )
        .context("append effective semantic model identity before inference")?;
        self.context.model = actual_model;
        self.effective_model_recorded = true;
        Ok(())
    }

    /// Finish an execution whose model/tokenizer preparation failed after the
    /// initial request was durably recorded but before ONNX inference began.
    pub fn fail_preparation<T>(&mut self, error: anyhow::Error) -> anyhow::Result<T> {
        anyhow::ensure!(
            matches!(
                self.state,
                SessionState::Prepared | SessionState::Dispatched
            ),
            "semantic audit session is not awaiting preparation"
        );
        let raw_error = format!("{error:#}");
        let (sanitized_error, redactions) = sanitize_local_error(&raw_error);
        let failed = event(
            &self.context,
            &self.execution_id,
            "execution.failed",
            json!({
                "captureState": if redactions.as_array().is_some_and(|items| !items.is_empty()) {
                    "redacted"
                } else {
                    "complete"
                },
                "phase": "local-inference-artifact-preparation",
                "modelDispatched": false,
                "onnxSessionRunObserved": false,
                "error": { "message": sanitized_error.clone() },
                "redactions": redactions,
            }),
        );
        let append_result = append_exact_with_retry(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[failed],
        );
        self.state = SessionState::Terminal;
        if let Err(audit_error) = append_result {
            return Err(anyhow::anyhow!(
                "semantic preparation failed: {sanitized_error}; terminal audit append failed: {audit_error:#}"
            ));
        }
        Err(anyhow::anyhow!(sanitized_error))
    }

    pub fn dispatch_and_run<T>(
        &mut self,
        inference: impl FnOnce() -> anyhow::Result<T>,
        output_payload: impl FnOnce(&T) -> Value,
    ) -> anyhow::Result<T> {
        anyhow::ensure!(
            self.state == SessionState::Dispatched,
            "semantic audit session was already dispatched"
        );
        if self.requires_effective_model_receipt && !self.effective_model_recorded {
            return self.fail_preparation(anyhow::anyhow!(
                "semantic effective tokenizer identity was not recorded before inference"
            ));
        }
        match inference() {
            Ok(output) => {
                let response = event(
                    &self.context,
                    &self.execution_id,
                    "response.completed",
                    merge_payload(
                        json!({
                            "captureState": "complete",
                            "outputRepresentation": "complete-domain-result",
                        }),
                        output_payload(&output),
                    ),
                );
                let succeeded = event(
                    &self.context,
                    &self.execution_id,
                    "execution.succeeded",
                    json!({
                        "captureState": "complete",
                        "modelDispatched": true,
                        "localPipelineCompleted": true,
                        "onnxResultObserved": true,
                    }),
                );
                let terminal = [response, succeeded];
                let append_result = append_exact_with_retry(
                    self.appender.as_ref(),
                    self.context.project_id.as_deref(),
                    &terminal,
                );
                self.state = SessionState::Terminal;
                append_result.context("append semantic completed output before returning")?;
                Ok(output)
            }
            Err(error) => {
                let raw_error = format!("{error:#}");
                let (sanitized_error, redactions) = sanitize_local_error(&raw_error);
                let failed = event(
                    &self.context,
                    &self.execution_id,
                    "execution.failed",
                    json!({
                        "captureState": if redactions.as_array().is_some_and(|items| !items.is_empty()) {
                            "redacted"
                        } else {
                            "complete"
                        },
                        "phase": "local-inference-pipeline",
                        "modelDispatched": null,
                        "onnxSessionRunObserved": null,
                        "error": { "message": sanitized_error.clone() },
                        "redactions": redactions,
                    }),
                );
                let append_result = append_exact_with_retry(
                    self.appender.as_ref(),
                    self.context.project_id.as_deref(),
                    &[failed],
                );
                self.state = SessionState::Terminal;
                if let Err(audit_error) = append_result {
                    return Err(anyhow::anyhow!(
                        "semantic inference failed: {sanitized_error}; terminal audit append failed: {audit_error:#}"
                    ));
                }
                Err(anyhow::anyhow!(sanitized_error))
            }
        }
    }
}

impl Drop for SemanticAuditSession {
    fn drop(&mut self) {
        if self.state == SessionState::Terminal {
            return;
        }
        let (event_type, phase, model_dispatched, onnx_observed) = if std::thread::panicking() {
            ("execution.failed", "panic-unwind", Value::Null, Value::Null)
        } else {
            (
                "execution.cancelled",
                "dropped-before-terminal-observation",
                Value::Null,
                Value::Null,
            )
        };
        let terminal = event(
            &self.context,
            &self.execution_id,
            event_type,
            json!({
                "captureState": "complete",
                "phase": phase,
                "modelDispatched": model_dispatched,
                "onnxSessionRunObserved": onnx_observed,
            }),
        );
        let _ = append_exact_with_retry(
            self.appender.as_ref(),
            self.context.project_id.as_deref(),
            &[terminal],
        );
        self.state = SessionState::Terminal;
    }
}

pub fn embedding_output_payload(embedding: &[f32]) -> Value {
    let bytes = embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect::<Vec<_>>();
    json!({
        "captureState": "partial",
        "outputRepresentation": "embedding-fingerprint",
        "embeddingDim": embedding.len(),
        "embeddingSha256": sha256_hex(bytes),
        "rawEmbeddingOmitted": true,
        "rawEmbeddingOmissionReason": "latent numeric vector; exact input and pinned model fingerprint are retained",
        "limitations": ["raw-embedding-vector-omitted"],
    })
}

pub fn append_semantic_non_execution(
    appender: Arc<dyn SemanticAuditAppender>,
    project_id: Option<&str>,
    operation_id: &str,
    path_id: &str,
    event_type: &str,
    reason: &str,
    details: Value,
) -> anyhow::Result<String> {
    let execution_id = Uuid::new_v4().to_string();
    let context = SemanticAuditContext {
        project_id: project_id.map(str::to_owned),
        operation_id: operation_id.to_string(),
        parent_execution_id: None,
        path_id: path_id.to_string(),
        inference_kind: "semantic.non-execution".to_string(),
        model: Value::Null,
        input: Value::Null,
        metadata: details,
    };
    let started = event(
        &context,
        &execution_id,
        "execution.started",
        json!({
            "captureState": "complete",
            "modelDispatched": false,
        }),
    );
    let terminal = event(
        &context,
        &execution_id,
        event_type,
        json!({
            "captureState": "complete",
            "reason": reason,
            "modelDispatched": false,
            "onnxSessionRunObserved": false,
        }),
    );
    append_exact_with_retry(appender.as_ref(), project_id, &[started, terminal])?;
    Ok(execution_id)
}

pub fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn sanitize_local_error(raw_error: &str) -> (String, Value) {
    let sanitized = sanitize_diagnostic_credentials(raw_error);
    if sanitized == raw_error {
        return (sanitized, json!([]));
    }
    (
        sanitized,
        json!([{
            "category": "credential",
            "ruleId": "local-inference-error-credentials-v1",
            "path": "error.message",
            "originalByteLength": raw_error.len(),
            "originalSha256": sha256_hex(raw_error.as_bytes()),
            "placeholder": "[REDACTED:credential]",
            "reversible": false,
        }]),
    )
}

fn append_exact_with_retry(
    appender: &dyn SemanticAuditAppender,
    project_id: Option<&str>,
    events: &[AppendAiAuditEvent],
) -> anyhow::Result<()> {
    match appender.append(project_id, events) {
        Ok(()) => Ok(()),
        Err(first_error) => appender.append(project_id, events).with_context(|| {
            format!("retry semantic audit append after first failure: {first_error:#}")
        }),
    }
}

fn merge_payload(base: Value, extra: Value) -> Value {
    let mut merged = match base {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    if let Value::Object(extra) = extra {
        merged.extend(extra);
    }
    Value::Object(merged)
}

fn tokenization_capture() -> Value {
    json!({
        "rawSourceText": "retained-exactly",
        "modelVisibleText": "retained-exactly-before-tokenization",
        "realizedTokenIds": "not-retained",
        "specialTokenExpansion": "not-retained",
        "postTruncationTokenSequence": "not-retained",
    })
}

fn tokenization_limitations() -> Value {
    json!([
        "realized-token-ids-not-retained",
        "special-token-expansion-not-retained",
        "post-truncation-token-sequence-not-retained",
        "raw-source-and-model-visible-text-retained-exactly",
        "model-internal-attention-hidden-states-and-implementation-details-not-observable",
    ])
}

fn has_valid_tokenizer_identity(model: &Value) -> bool {
    let Some(identity) = model.get("tokenizerIdentity") else {
        return false;
    };
    let valid_sha256 = identity
        .get("sha256")
        .and_then(Value::as_str)
        .is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
    identity.get("identityVersion").and_then(Value::as_u64)
        == Some(TOKENIZER_IDENTITY_VERSION.into())
        && identity.get("fingerprintAlgorithm").and_then(Value::as_str) == Some("sha256")
        && identity
            .get("fileName")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        && valid_sha256
        && identity.get("byteLength").and_then(Value::as_u64).is_some()
}

fn payload_with_context(context: &SemanticAuditContext, body: Value) -> Value {
    merge_payload(
        json!({
            "inferenceKind": context.inference_kind,
            "metadata": context.metadata,
        }),
        body,
    )
}

fn event(
    context: &SemanticAuditContext,
    execution_id: &str,
    event_type: &str,
    payload: Value,
) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: Uuid::new_v4().to_string(),
        execution_id: execution_id.to_string(),
        operation_id: context.operation_id.clone(),
        parent_execution_id: context.parent_execution_id.clone(),
        path_id: context.path_id.clone(),
        event_type: event_type.to_string(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        payload: payload_with_context(context, payload),
    }
}
