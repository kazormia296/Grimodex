use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Context;
use grimodex_db::ai_audit::{sanitize_diagnostic_credentials, AppendAiAuditEvent};
use grimodex_db::Database;
use rusqlite::params;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;

use crate::{PostEffectAiClient, PostEffectAiOutput, PostEffectAiRequest};

pub(crate) trait PostEffectAuditAppender: Send + Sync + 'static {
    fn append(&self, project_id: &str, events: &[AppendAiAuditEvent]) -> anyhow::Result<()>;
}

impl PostEffectAuditAppender for Database {
    fn append(&self, project_id: &str, events: &[AppendAiAuditEvent]) -> anyhow::Result<()> {
        self.append_ai_audit_events(project_id, events).map(|_| ())
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PostEffectAuditContext {
    pub project_id: String,
    pub operation_id: String,
    pub run_id: String,
    pub scene_id: String,
    pub effect_type: String,
    pub path_id: String,
    pub scope_type: String,
    pub scope_target_id: Option<String>,
    pub prompt_version: String,
    pub requested_model: String,
    pub parent_execution_id: Option<String>,
    pub retry_of_execution_id: Option<String>,
}

pub(crate) fn post_effect_audit_context(
    database: &Database,
    project_id: &str,
    run_id: &str,
    scene_id: &str,
    operation_id: Option<String>,
) -> anyhow::Result<PostEffectAuditContext> {
    let (effect_type, scope_type, scope_target_id, requested_model, prompt_version) = database
        .with_conn(|conn| {
            conn.query_row(
                "SELECT effect_type, scope_type, scope_target_id, model, prompt_version
                   FROM post_effect_runs
                  WHERE id = ? AND project_id = ?",
                params![run_id, project_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(anyhow::Error::from)
        })?;
    let path_id = post_effect_path_id(&effect_type, &prompt_version);
    Ok(PostEffectAuditContext {
        project_id: project_id.to_string(),
        operation_id: operation_id.unwrap_or_else(|| run_id.to_string()),
        run_id: run_id.to_string(),
        scene_id: scene_id.to_string(),
        effect_type,
        path_id,
        scope_type,
        scope_target_id,
        prompt_version,
        requested_model,
        parent_execution_id: None,
        retry_of_execution_id: None,
    })
}

pub(crate) fn post_effect_path_id(effect_type: &str, prompt_version: &str) -> String {
    if effect_type == "pseudo_comment"
        && prompt_version == crate::LIVE_PSEUDO_COMMENT_PROMPT_VERSION
    {
        "post_effect_live_pseudo_comment".to_string()
    } else {
        format!("post_effect_{effect_type}")
    }
}

pub(crate) fn normalized_endpoint_host(base_url: &str) -> Option<String> {
    let parsed = Url::parse(base_url).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    match parsed.port() {
        Some(port) => Some(format!("{host}:{port}")),
        None => Some(host),
    }
}

/// Provider errors can contain the request URL. Keep the diagnostic host/path
/// while stripping user-info, query strings, and fragments before durability.
pub(crate) fn sanitize_provider_error(error: &str) -> String {
    sanitize_diagnostic_credentials(error)
}

fn timestamp_ms() -> anyhow::Result<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis();
    i64::try_from(millis).context("AI audit timestamp exceeds i64")
}

fn payload_with_context(context: &PostEffectAuditContext, body: Value) -> Value {
    let mut payload = match body {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    payload.insert("runId".into(), json!(context.run_id));
    payload.insert("sceneId".into(), json!(context.scene_id));
    payload.insert("effectType".into(), json!(context.effect_type));
    payload.insert("scopeType".into(), json!(context.scope_type));
    payload.insert("scopeTargetId".into(), json!(context.scope_target_id));
    payload.insert("promptVersion".into(), json!(context.prompt_version));
    payload.insert("requestedModel".into(), json!(context.requested_model));
    payload.insert(
        "retryOfExecutionId".into(),
        json!(context.retry_of_execution_id),
    );
    Value::Object(payload)
}

fn event(
    context: &PostEffectAuditContext,
    execution_id: &str,
    event_type: &str,
    payload: Value,
) -> anyhow::Result<AppendAiAuditEvent> {
    Ok(AppendAiAuditEvent {
        event_id: Uuid::new_v4().to_string(),
        execution_id: execution_id.to_string(),
        operation_id: context.operation_id.clone(),
        parent_execution_id: context.parent_execution_id.clone(),
        path_id: context.path_id.clone(),
        event_type: event_type.to_string(),
        timestamp: timestamp_ms()?,
        payload: payload_with_context(context, payload),
    })
}

struct AuditTerminalGuard<S: PostEffectAuditAppender + ?Sized> {
    appender: Arc<S>,
    context: PostEffectAuditContext,
    execution_id: String,
    armed: bool,
    fallback_event_type: &'static str,
    fallback_phase: &'static str,
    fallback_capture_state: &'static str,
    fallback_details: Value,
    fallback_limitations: Vec<String>,
}

impl<S: PostEffectAuditAppender + ?Sized> AuditTerminalGuard<S> {
    fn new(
        appender: Arc<S>,
        context: PostEffectAuditContext,
        execution_id: String,
        capture_state: &'static str,
        limitations: Vec<String>,
    ) -> Self {
        Self {
            appender,
            context,
            execution_id,
            armed: true,
            fallback_event_type: "execution.cancelled",
            fallback_phase: "in_flight_future_dropped",
            fallback_capture_state: capture_state,
            fallback_details: json!({}),
            fallback_limitations: limitations,
        }
    }

    fn mark_provider_failure(
        &mut self,
        sanitized_error: &str,
        capture_state: &'static str,
        redactions: Value,
    ) {
        self.fallback_event_type = "execution.failed";
        self.fallback_phase = "provider_call";
        self.fallback_capture_state = capture_state;
        self.fallback_details = json!({
            "error": { "message": sanitized_error },
            "redactions": redactions,
        });
    }

    fn mark_terminal_append_failure(&mut self, raw_response: &str) {
        self.fallback_event_type = "execution.failed";
        self.fallback_phase = "terminal_audit_append";
        self.fallback_capture_state = "partial";
        if !self
            .fallback_limitations
            .iter()
            .any(|value| value == "observable-response-not-durable")
        {
            self.fallback_limitations
                .push("observable-response-not-durable".to_string());
        }
        self.fallback_details = json!({
            "observableResponseSha256": hex::encode(Sha256::digest(raw_response.as_bytes())),
            "observableResponseByteLength": raw_response.len(),
            "rawResponsePersisted": false,
        });
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl<S: PostEffectAuditAppender + ?Sized> Drop for AuditTerminalGuard<S> {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let (event_type, phase) = if std::thread::panicking() {
            ("execution.failed", "panic_unwind")
        } else {
            (self.fallback_event_type, self.fallback_phase)
        };
        let mut fallback_payload = json!({
            "captureState": self.fallback_capture_state,
            "phase": phase,
            "clientDispatchAttempted": true,
            "modelDispatched": Value::Null,
            "providerReceiptObserved": Value::Null,
            "limitations": self.fallback_limitations,
        });
        if let (Some(base), Some(details)) = (
            fallback_payload.as_object_mut(),
            self.fallback_details.as_object(),
        ) {
            base.extend(details.clone());
        }
        let fallback = event(
            &self.context,
            &self.execution_id,
            event_type,
            fallback_payload,
        );
        let result = fallback.and_then(|fallback| {
            append_exact_with_retry(
                self.appender.as_ref(),
                &self.context.project_id,
                &[fallback],
                "post-effect unwind/cancel terminal audit append",
            )
        });
        if let Err(error) = result {
            tracing::error!(
                execution_id = %self.execution_id,
                run_id = %self.context.run_id,
                scene_id = %self.context.scene_id,
                error = %error,
                "failed to append post-effect unwind/cancel audit terminal"
            );
        }
    }
}

fn credential_redactions(raw_value: &str, was_redacted: bool) -> Value {
    if !was_redacted {
        return json!([]);
    }
    json!([{
        "category": "credential",
        "ruleId": "provider-error-credentials-v1",
        "path": "error.message",
        "originalByteLength": raw_value.len(),
        "originalSha256": hex::encode(Sha256::digest(raw_value.as_bytes())),
        "placeholder": "[REDACTED:credential]",
        "reversible": false,
    }])
}

fn append_exact_with_retry<S: PostEffectAuditAppender + ?Sized>(
    appender: &S,
    project_id: &str,
    events: &[AppendAiAuditEvent],
    description: &str,
) -> anyhow::Result<()> {
    match appender.append(project_id, events) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            tracing::warn!(%first_error, %description, "retrying exact post-effect audit append");
            appender.append(project_id, events).with_context(|| {
                format!("{description} failed after bounded retry; first append: {first_error:#}")
            })
        }
    }
}

/// Audit one real post-effect model dispatch. The initial event batch is
/// committed before `ai.call`, so audit append failure is fail-closed and no
/// model request can escape without a durable prepared/dispatched record.
pub(crate) async fn call_post_effect_ai_with_appender<A, S>(
    appender: Arc<S>,
    ai: &A,
    context: PostEffectAuditContext,
    request: PostEffectAiRequest<'_>,
) -> anyhow::Result<PostEffectAiOutput>
where
    A: PostEffectAiClient,
    S: PostEffectAuditAppender + ?Sized,
{
    let execution_id = Uuid::new_v4().to_string();
    let provider_override = request
        .role_override
        .provider
        .as_ref()
        .map(ToString::to_string);
    let request_system_prompt = request.system_prompt.to_string();
    let request_codex_content = request.codex_content.map(str::to_string);
    let request_scene_content = request.scene_content.to_string();
    let model_override = request.model_override.map(str::to_string);
    let api_variant_override = request.role_override.api_variant.clone();
    let endpoint_id_override = request.role_override.endpoint_id.clone();
    let requested_model = model_override
        .as_deref()
        .filter(|model| !model.is_empty())
        .unwrap_or(&context.requested_model)
        .to_string();
    let (resolved, dispatch) = match ai.prepare_call(request) {
        Ok(prepared) => prepared,
        Err(error) => {
            let raw_error = format!("{error:#}");
            let sanitized_error = sanitize_provider_error(&raw_error);
            let was_redacted = sanitized_error != raw_error;
            let redactions = credential_redactions(&raw_error, was_redacted);
            let requested_provider = provider_override.clone();
            let preparation_failure = vec![
                event(
                    &context,
                    &execution_id,
                    "execution.started",
                    json!({
                        "captureState": "partial",
                        "modelDispatched": false,
                        "limitations": ["exact-effective-request-body-unavailable"],
                    }),
                )?,
                event(
                    &context,
                    &execution_id,
                    "request.prepared",
                    json!({
                        "captureState": "partial",
                        "credentialsExcluded": true,
                        "request": {
                            "system_prompt": request_system_prompt,
                            "codex_content": request_codex_content,
                            "scene_content": request_scene_content,
                            "body": Value::Null,
                            "wireRoute": Value::Null,
                            "effectiveOutputTokenLimit": Value::Null,
                        },
                        "route": {
                            "configured_model": context.requested_model,
                            "requested_model": requested_model,
                            "model_override": model_override,
                            "requested_provider": requested_provider,
                            "provider_override": provider_override,
                            "api_variant_override": api_variant_override,
                            "endpoint_id_override": endpoint_id_override,
                            "resolved_model": Value::Null,
                            "resolved_provider": Value::Null,
                            "resolved_api_variant": Value::Null,
                            "resolved_endpoint_id": Value::Null,
                            "endpoint_host": Value::Null,
                            "resolutionState": "failed",
                        },
                        "limitations": ["exact-effective-request-body-unavailable", "resolved-provider-route-unavailable"],
                    }),
                )?,
                event(
                    &context,
                    &execution_id,
                    "execution.failed",
                    json!({
                        "captureState": if was_redacted { "redacted" } else { "partial" },
                        "phase": "route_preparation",
                        "clientDispatchAttempted": false,
                        "modelDispatched": false,
                        "providerReceiptObserved": false,
                        "error": { "message": sanitized_error.clone() },
                        "redactions": redactions,
                        "limitations": ["resolved-provider-route-unavailable"],
                    }),
                )?,
            ];
            append_exact_with_retry(
                appender.as_ref(),
                &context.project_id,
                &preparation_failure,
                "append post-effect route preparation failure",
            )?;
            return Err(anyhow::anyhow!(sanitized_error));
        }
    };
    let requested_provider = provider_override
        .clone()
        .unwrap_or_else(|| resolved.provider.clone());
    let effective_request_body = resolved
        .effective_request
        .as_ref()
        .map(|prepared| prepared.body.clone())
        .unwrap_or(Value::Null);
    let effective_wire_route = resolved
        .effective_request
        .as_ref()
        .and_then(|prepared| serde_json::to_value(prepared.route).ok())
        .unwrap_or(Value::Null);
    let effective_output_token_limit = resolved
        .effective_request
        .as_ref()
        .and_then(|prepared| serde_json::to_value(&prepared.output_token_limit).ok())
        .unwrap_or(Value::Null);
    let mut limitations = resolved.limitations.clone();
    if resolved
        .effective_request
        .as_ref()
        .is_some_and(|prepared| prepared.output_token_limit.omitted)
    {
        limitations.push("provider-default-output-token-limit-not-observable".to_string());
    }
    let capture_state = if resolved.provider.is_empty()
        || resolved.model.is_empty()
        || resolved.effective_request.is_none()
        || !limitations.is_empty()
    {
        "partial"
    } else {
        "complete"
    };
    let initial = vec![
        event(
            &context,
            &execution_id,
            "execution.started",
            json!({
                "captureState": capture_state,
                "modelDispatched": false,
                "limitations": limitations,
            }),
        )?,
        event(
            &context,
            &execution_id,
            "request.prepared",
            json!({
                "captureState": capture_state,
                "credentialsExcluded": true,
                "request": {
                    "system_prompt": request_system_prompt,
                    "codex_content": request_codex_content,
                    "scene_content": request_scene_content,
                    "body": effective_request_body,
                    "wireRoute": effective_wire_route,
                    "effectiveOutputTokenLimit": effective_output_token_limit,
                },
                "route": {
                    "configured_model": context.requested_model,
                    "requested_model": requested_model,
                    "model_override": model_override,
                    "requested_provider": requested_provider,
                    "provider_override": provider_override,
                    "api_variant_override": api_variant_override,
                    "endpoint_id_override": endpoint_id_override,
                    "resolved_model": resolved.model,
                    "resolved_provider": resolved.provider,
                    "resolved_api_variant": resolved.api_variant,
                    "resolved_endpoint_id": resolved.endpoint_id,
                    "endpoint_host": resolved.endpoint_host,
                },
                "limitations": limitations,
            }),
        )?,
        event(
            &context,
            &execution_id,
            "request.dispatched",
            json!({
                "captureState": capture_state,
                "clientDispatchAttempted": true,
                "modelDispatched": Value::Null,
                "dispatchBoundary": "before_client_call",
                "providerReceiptObserved": false,
                "limitations": limitations,
            }),
        )?,
    ];
    append_exact_with_retry(
        appender.as_ref(),
        &context.project_id,
        &initial,
        "append prepared post-effect AI audit events before dispatch",
    )?;

    let mut terminal_guard = AuditTerminalGuard::new(
        appender.clone(),
        context.clone(),
        execution_id.clone(),
        capture_state,
        limitations.clone(),
    );
    let result = dispatch().await;
    let output = match result {
        Ok(output) => output,
        Err(error) => {
            let raw_error = error.to_string();
            let sanitized_error = sanitize_provider_error(&raw_error);
            let was_redacted = sanitized_error != raw_error;
            let failure_capture_state = if was_redacted {
                "redacted"
            } else {
                capture_state
            };
            let redactions = credential_redactions(&raw_error, was_redacted);
            terminal_guard.mark_provider_failure(
                &sanitized_error,
                failure_capture_state,
                redactions.clone(),
            );
            let failure = event(
                &context,
                &execution_id,
                "execution.failed",
                json!({
                    "captureState": failure_capture_state,
                    "phase": "provider_call",
                    "clientDispatchAttempted": true,
                    "modelDispatched": Value::Null,
                    "providerReceiptObserved": Value::Null,
                    "error": {
                        "message": sanitized_error.clone(),
                    },
                    "redactions": redactions,
                    "limitations": limitations,
                }),
            )?;
            append_exact_with_retry(
                appender.as_ref(),
                &context.project_id,
                &[failure],
                "append post-effect provider failure audit terminal",
            )?;
            terminal_guard.disarm();
            return Err(anyhow::anyhow!(sanitized_error));
        }
    };

    let completed = vec![
        event(
            &context,
            &execution_id,
            "response.completed",
            json!({
                "captureState": capture_state,
                "raw_response": output.raw_response.clone(),
                "detected_model": output.detected_model.clone(),
                "modelDispatched": true,
                "providerReceiptObserved": true,
                "limitations": limitations,
            }),
        )?,
        event(
            &context,
            &execution_id,
            "execution.succeeded",
            json!({
                "captureState": capture_state,
                "clientDispatchAttempted": true,
                "modelDispatched": true,
                "providerReceiptObserved": true,
                "limitations": limitations,
            }),
        )?,
    ];
    if let Err(error) = append_exact_with_retry(
        appender.as_ref(),
        &context.project_id,
        &completed,
        "append post-effect raw response audit terminal",
    ) {
        terminal_guard.mark_terminal_append_failure(&output.raw_response);
        return Err(error);
    }
    terminal_guard.disarm();
    Ok(output)
}

pub(crate) fn append_post_effect_non_execution<S: PostEffectAuditAppender + ?Sized>(
    appender: Arc<S>,
    context: PostEffectAuditContext,
    event_type: &str,
    reason: &str,
    related_execution_id: Option<&str>,
    details: Value,
) -> anyhow::Result<String> {
    let execution_id = Uuid::new_v4().to_string();
    let source_execution_missing =
        event_type == "execution.cache_hit" && related_execution_id.is_none();
    let capture_state = if source_execution_missing {
        "partial"
    } else {
        "complete"
    };
    let limitations = if source_execution_missing {
        json!(["cache-source-execution-unavailable"])
    } else {
        json!([])
    };
    let events = vec![
        event(
            &context,
            &execution_id,
            "execution.started",
            json!({
                "captureState": capture_state,
                "modelDispatched": false,
                "limitations": limitations.clone(),
            }),
        )?,
        event(
            &context,
            &execution_id,
            event_type,
            json!({
                "captureState": capture_state,
                "modelDispatched": false,
                "reason": reason,
                "relatedExecutionId": related_execution_id,
                "relatedRunId": context.run_id,
                "details": details,
                "limitations": limitations,
            }),
        )?,
    ];
    append_exact_with_retry(
        appender.as_ref(),
        &context.project_id,
        &events,
        "append post-effect non-execution audit",
    )?;
    Ok(execution_id)
}
