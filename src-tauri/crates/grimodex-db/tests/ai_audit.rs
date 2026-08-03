use grimodex_db::ai_audit::{
    redact_quoted_json_credentials, sanitize_diagnostic_credentials, AppendAiAuditEvent,
};
use grimodex_db::Database;
use serde_json::json;
use sha2::{Digest, Sha256};

fn event(event_id: &str, event_type: &str, timestamp: i64) -> AppendAiAuditEvent {
    AppendAiAuditEvent {
        event_id: event_id.to_string(),
        execution_id: "execution-1".to_string(),
        operation_id: "operation-1".to_string(),
        parent_execution_id: None,
        path_id: "chat.direct".to_string(),
        event_type: event_type.to_string(),
        timestamp,
        payload: json!({
            "captureState": "complete",
            "credentialsExcluded": true,
            "message": event_id,
        }),
    }
}

fn migrated_db() -> Database {
    let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
    db.migrate().expect("migrate database");
    db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO projects (id, title, created_at, updated_at)
             VALUES ('project-1', 'Project', datetime('now'), datetime('now'))",
            [],
        )?;
        Ok(())
    })
    .expect("seed project");
    db
}

fn cli_request_sha256() -> String {
    hex::encode(Sha256::digest(
        br#"{"cli":"codex","model":"gpt-test","prompt":"hello"}"#,
    ))
}

#[test]
fn quoted_json_diagnostic_credentials_are_redacted_without_touching_benign_fields() {
    let source = r#"provider failed: {"api_key":"api-secret","Authorization":"Bearer auth-secret","nested":{"accessToken":"token-secret","password":"pass-secret","session_cookie":"cookie-secret","AWS_ACCESS_KEY_ID":"access-id-secret","aws_secret_access_key":"access-key-secret","OPENAI_PRIVATE_KEY":"private-key-secret","providerAuth":"auth-alias-secret"},"model":"fictional-token-model","message":"keep exact"}"#;
    let sanitized = redact_quoted_json_credentials(source);

    for secret in [
        "api-secret",
        "auth-secret",
        "token-secret",
        "pass-secret",
        "cookie-secret",
        "access-id-secret",
        "access-key-secret",
        "private-key-secret",
        "auth-alias-secret",
    ] {
        assert!(!sanitized.contains(secret));
    }
    assert!(sanitized.contains("[REDACTED:credential]"));
    assert!(sanitized.contains(r#""model":"fictional-token-model""#));
    assert!(sanitized.contains(r#""message":"keep exact""#));
}

#[test]
fn diagnostic_credentials_are_redacted_across_url_assignment_json_and_headers() {
    let source = concat!(
        "provider failed at https://url-user:url-pass@example.test/v1/chat?api_key=url-secret#fragment ",
        "token=assignment-secret ",
        "OPENAI_API_KEY = \"quoted assignment secret\" ",
        "AWS_ACCESS_KEY_ID = 'quoted access id' ",
        "provider_private_key = \"quoted private key\" ",
        "auth_anthropic = 'quoted auth alias' ",
        "invalid key sk-ant-provider-secret ",
        r#"body={"apiKey":"json-secret","message":"keep exact"}"#,
        "\nAuthorization: Bearer header-secret",
        "\nAuthentication: Basic authentication-secret",
        "\nX-Api-Key: provider-header-secret",
        "\nbenign diagnostic"
    );
    let sanitized = sanitize_diagnostic_credentials(source);

    for secret in [
        "url-user",
        "url-pass",
        "url-secret",
        "fragment",
        "assignment-secret",
        "quoted assignment secret",
        "quoted access id",
        "quoted private key",
        "quoted auth alias",
        "sk-ant-provider-secret",
        "json-secret",
        "header-secret",
        "authentication-secret",
        "provider-header-secret",
    ] {
        assert!(!sanitized.contains(secret), "leaked {secret}: {sanitized}");
    }
    assert!(sanitized.contains("https://example.test/v1/chat"));
    assert!(sanitized.contains(r#""message":"keep exact""#));
    assert!(sanitized.contains("benign diagnostic"));
    assert!(sanitized.contains("[REDACTED:credential]"));
}

#[test]
fn append_rejects_transport_credential_metadata_but_preserves_ai_visible_fiction() {
    for (index, credential_key) in [
        "apiKey",
        "PRIVATE_KEY",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "openaiAuth",
        "auth_anthropic",
    ]
    .into_iter()
    .enumerate()
    {
        let db = migrated_db();
        let mut rejected = event(
            &format!("credential-event-{index}"),
            "execution.started",
            index as i64 + 1,
        );
        rejected.payload = json!({
            "captureState": "complete",
            "metadata": {},
        });
        rejected.payload["metadata"][credential_key] = json!("must-not-persist");
        let error = db
            .append_ai_audit_events("project-1", &[rejected])
            .expect_err("transport credential metadata must fail closed");
        assert!(
            error
                .to_string()
                .contains("contains excluded transport credentials"),
            "unexpected error for {credential_key}: {error:#}"
        );
    }

    for (index, forbidden_payload) in [
        json!({ "metadata": { "context": { "apiKey": "metadata-secret" } } }),
        json!({ "error": { "content": { "authentication": "error-secret" } } }),
        json!({ "diagnostic": { "body": { "privateKey": "diagnostic-secret" } } }),
        json!({ "effectiveRequestConfiguration": { "messages": [{ "content": { "auth": "configuration-secret" } }] } }),
        json!({ "request": { "options": { "context": { "accessToken": "option-secret" } } } }),
        json!({ "request": { "auditMetadata": { "apiKey": "audit-metadata-secret" } } }),
        json!({ "request": { "context": { "apiKey": "legacy-context-secret" } } }),
    ]
    .into_iter()
    .enumerate()
    {
        let db = migrated_db();
        let mut rejected = event(
            &format!("nested-credential-event-{index}"),
            "request.prepared",
            index as i64 + 20,
        );
        rejected.payload = json!({
            "captureState": "complete",
            "credentialsExcluded": true,
        });
        rejected
            .payload
            .as_object_mut()
            .expect("payload object")
            .extend(forbidden_payload.as_object().expect("fixture object").clone());
        let error = db
            .append_ai_audit_events("project-1", &[rejected])
            .expect_err("same-named containers outside declared model-visible paths must fail");
        assert!(
            error
                .to_string()
                .contains("contains excluded transport credentials"),
            "unexpected nested-path error: {error:#}"
        );
    }

    let db = migrated_db();
    let mut visible = event("visible-fiction", "request.prepared", 10);
    visible.payload = json!({
        "captureState": "complete",
        "credentialsExcluded": true,
        "usage": { "inputTokens": 5, "outputTokens": 3, "tokens": 8 },
        "request": {
            "modelVisibleContext": {
                "apiKey": "fictional contextual key",
                "authentication": "fictional contextual oath"
            },
            "messages": [{
                "role": "user",
                "content": {
                    "apiKey": "fictional API key",
                    "PRIVATE_KEY": "fictional private key",
                    "AWS_ACCESS_KEY_ID": "fictional access id",
                    "metadata": {
                        "auth": "story oath",
                        "token": "arc token",
                        "password": "riddle password",
                        "secret": "character secret"
                    }
                }
            }]
        }
    });
    db.append_ai_audit_events(
        "project-1",
        &[event("visible-start", "execution.started", 9), visible],
    )
    .expect("credential-shaped fiction under messages/content remains exact");
    let snapshot = db
        .read_ai_audit_snapshot("project-1", None, None, None)
        .expect("read exact visible content");
    assert_eq!(
        snapshot.events[1].payload["request"]["messages"][0]["content"]["metadata"]["auth"],
        "story oath"
    );
    assert_eq!(
        snapshot.events[1].payload["request"]["modelVisibleContext"]["apiKey"],
        "fictional contextual key"
    );

    let db = migrated_db();
    let mut tool_message = event("visible-tool-message", "request.prepared", 11);
    tool_message.payload = json!({
        "captureState": "complete",
        "credentialsExcluded": true,
        "request": {
            "messages": [{
                "role": "assistant",
                "content": "tool call",
                "thinkingBlocks": [{
                    "metadata": { "authentication": "fictional reasoning label" }
                }],
                "toolUses": [{
                    "id": "tool-1",
                    "name": "fictional_tool",
                    "input": { "apiKey": "fictional tool input" }
                }]
            }]
        }
    });
    db.append_ai_audit_events(
        "project-1",
        &[
            event("visible-tool-start", "execution.started", 10),
            tool_message,
        ],
    )
    .expect("the complete normalized message object remains model-visible evidence");

    let db = migrated_db();
    let mut semantic_visible = event("semantic-visible-fiction", "request.prepared", 12);
    semantic_visible.payload = json!({
        "captureState": "complete",
        "credentialsExcluded": true,
        "input": {
            "content": {
                "apiKey": "fictional semantic input",
                "authentication": "fictional oath"
            }
        }
    });
    db.append_ai_audit_events(
        "project-1",
        &[
            event("semantic-visible-start", "execution.started", 11),
            semantic_visible,
        ],
    )
    .expect("native semantic payload.input remains an exact declared model-visible branch");

    let db = migrated_db();
    let mut diagnostic = event("runtime-diagnostic-secret", "response.partial", 13);
    diagnostic.payload = json!({
        "captureState": "complete",
        "response": {
            "runtimeDiagnostic": {
                "content": { "authentication": "must-not-persist" }
            }
        }
    });
    let error = db
        .append_ai_audit_events("project-1", &[diagnostic])
        .expect_err("generated runtime diagnostics must re-enter credential validation");
    assert!(
        error
            .to_string()
            .contains("contains excluded transport credentials"),
        "unexpected runtime diagnostic error: {error:#}"
    );

    let db = migrated_db();
    let mut observed_tool_output = event("observed-tool-fiction", "response.partial", 14);
    observed_tool_output.payload = json!({
        "captureState": "complete",
        "response": {
            "runtimeEvent": {
                "item": {
                    "error": {
                        "metadata": {
                            "content": {
                                "apiKey": "fictional observed tool output"
                            }
                        }
                    }
                }
            }
        }
    });
    db.append_ai_audit_events(
        "project-1",
        &[
            event("observed-tool-start", "execution.started", 11),
            event("observed-tool-prepared", "request.prepared", 12),
            event("observed-tool-dispatched", "request.dispatched", 13),
            observed_tool_output,
        ],
    )
    .expect("application-observed model/tool output remains exact outside runtimeDiagnostic");
}

#[test]
fn append_accepts_semantic_tokenizer_metadata_without_accepting_token_credentials() {
    let db = migrated_db();
    let tokenizer_identity = json!({
        "identityVersion": 1,
        "fingerprintAlgorithm": "sha256",
        "fileName": "tokenizer.json",
        "sha256": "1c9a56712b0339da658730550d9a5210f0297fe62c4cd958a8f5a2556157f3c0",
        "byteLength": 1234,
    });
    let mut prepared = event("semantic-tokenizer-prepared", "request.prepared", 15);
    prepared.payload = json!({
        "captureState": "partial",
        "credentialsExcluded": true,
        "model": {
            "tokenizerIdentityStatus": "loaded-and-fingerprinted",
            "tokenizerIdentity": tokenizer_identity,
        },
        "input": {
            "modelText": "検索クエリ: 灯台",
            "tokenizerAddsSpecialTokens": true,
            "tokenizerMayTruncateAt": 256,
        },
        "tokenizationCapture": {
            "realizedTokenIds": "not-retained",
            "specialTokenExpansion": "not-retained",
            "postTruncationTokenSequence": "not-retained",
        },
    });
    let mut completed = event("semantic-tokenizer-output", "response.completed", 16);
    completed.payload = json!({
        "captureState": "complete",
        "tokenizerIdentity": tokenizer_identity,
        "scores": [{
            "tokenization": {
                "queryTokensBefore": 5,
                "queryTokensAfter": 5,
            }
        }],
    });

    db.append_ai_audit_events(
        "project-1",
        &[
            event("semantic-tokenizer-start", "execution.started", 14),
            prepared,
            event("semantic-tokenizer-dispatched", "request.dispatched", 15),
            completed,
        ],
    )
    .expect("semantic tokenizer identity and capture metadata are non-credential evidence");
    let snapshot = db
        .read_ai_audit_snapshot("project-1", None, None, None)
        .expect("read tokenizer audit metadata");
    assert_eq!(
        snapshot.events[1].payload["model"]["tokenizerIdentity"]["fileName"],
        "tokenizer.json"
    );
    assert_eq!(
        snapshot.events[3].payload["scores"][0]["tokenization"]["queryTokensAfter"],
        5
    );

    for (index, key) in [
        "tokenizerIdentitySecret",
        "tokenizerIdentityToken",
        "tokenizerIdentityExtra",
        "tokenizationCaptureBackup",
        "tokenizationAccessToken",
    ]
    .into_iter()
    .enumerate()
    {
        let db = migrated_db();
        let mut rejected = event(
            &format!("semantic-token-credential-{index}"),
            "execution.started",
            17 + index as i64,
        );
        rejected.payload["metadata"] = json!({ key: "must-not-persist" });
        let error = db
            .append_ai_audit_events("project-1", &[rejected])
            .expect_err("credential-bearing or undeclared token keys must remain excluded");
        assert!(
            error
                .to_string()
                .contains("contains excluded transport credentials"),
            "unexpected credential rejection for {key}: {error:#}"
        );
    }
}

#[test]
fn append_is_idempotent_and_snapshot_verification_detects_payload_tampering() {
    let db = migrated_db();
    let batch = [
        event("event-1", "execution.started", 1_700_000_000_001),
        event("event-2", "request.prepared", 1_700_000_000_002),
    ];

    let first = db
        .append_ai_audit_events("project-1", &batch)
        .expect("append audit events");
    assert_eq!(first.inserted_count, 2);
    assert_eq!(first.tail_sequence, 2);
    assert_eq!(first.tail_hash.len(), 64);

    let resent = db
        .append_ai_audit_events("project-1", &batch)
        .expect("resend audit events");
    assert_eq!(resent.inserted_count, 0);
    assert_eq!(resent.tail_sequence, 2);

    let snapshot = db
        .read_ai_audit_snapshot("project-1", None, None, None)
        .expect("read snapshot");
    assert_eq!(snapshot.high_water_sequence, 2);
    assert_eq!(snapshot.high_water_hash, first.tail_hash);
    assert_eq!(snapshot.events.len(), 2);
    assert_eq!(snapshot.next_after_sequence, None);
    assert_eq!(snapshot.events[0].sequence, 1);
    assert_eq!(snapshot.events[0].payload_sha256.len(), 64);
    assert!(snapshot.events[0].recorded_at > 0);
    assert_eq!(snapshot.events[0].payload["auditSchemaVersion"], 1);
    assert_eq!(snapshot.events[0].payload["captureContractVersion"], 1);
    assert_eq!(snapshot.events[0].payload["recorder"], "grimodex-ai-audit");
    assert_eq!(snapshot.events[0].payload["appVersion"], "unknown");

    let verified = db
        .verify_ai_audit_chain("project-1", Some(snapshot.high_water_sequence))
        .expect("verify snapshot");
    assert!(verified.ok);
    assert_eq!(verified.verified_through_sequence, 2);

    db.with_conn(|conn| {
        conn.execute(
            "UPDATE ai_audit_events SET payload = '{\"captureState\":\"complete\",\"tampered\":true}'
             WHERE project_id = 'project-1' AND sequence = 1",
            [],
        )?;
        Ok(())
    })
    .expect("tamper fixture");

    let broken = db
        .verify_ai_audit_chain("project-1", Some(2))
        .expect("verify tampered snapshot");
    assert!(!broken.ok);
    assert_eq!(broken.broken_at_sequence, Some(1));
}

#[test]
fn terminal_closes_execution_but_exact_event_retry_remains_idempotent() {
    let db = migrated_db();
    let terminal = event("event-terminal", "execution.cancelled", 4);
    db.append_ai_audit_events(
        "project-1",
        &[
            event("event-start", "execution.started", 1),
            event("event-prepared", "request.prepared", 2),
            event("event-dispatch", "request.dispatched", 3),
            terminal.clone(),
        ],
    )
    .expect("append terminal execution");

    let retry = db
        .append_ai_audit_events("project-1", &[terminal])
        .expect("exact eventId retry after terminal remains a no-op");
    assert_eq!(retry.inserted_count, 0);

    for rejected in [
        event("event-late", "response.partial", 4),
        event("event-second-terminal", "execution.succeeded", 5),
    ] {
        let error = db
            .append_ai_audit_events("project-1", &[rejected])
            .expect_err("terminal execution must reject new events");
        assert!(error.to_string().contains("already reached terminal"));
    }
}

#[test]
fn lifecycle_requires_start_prepared_dispatch_before_model_observations() {
    for event_type in [
        "request.prepared",
        "request.dispatched",
        "response.partial",
        "response.completed",
        "execution.succeeded",
    ] {
        let db = migrated_db();
        let error = db
            .append_ai_audit_events("project-1", &[event("first", event_type, 1)])
            .expect_err("execution must begin with execution.started");
        assert!(error
            .to_string()
            .contains("must begin with execution.started"));
    }

    for event_type in [
        "request.dispatched",
        "response.completed",
        "execution.succeeded",
    ] {
        let db = migrated_db();
        let error = db
            .append_ai_audit_events(
                "project-1",
                &[
                    event("ordered-start", "execution.started", 1),
                    event("out-of-order", event_type, 2),
                ],
            )
            .expect_err("dispatch-dependent events must fail before prepared/dispatch");
        assert!(
            error.to_string().contains("request.prepared")
                || error.to_string().contains("request.dispatched"),
            "unexpected lifecycle error: {error:#}"
        );
        assert_eq!(
            db.read_ai_audit_snapshot("project-1", None, None, None)
                .expect("read rolled-back lifecycle")
                .events
                .len(),
            0,
            "invalid batch must roll back its leading start"
        );
    }
}

#[test]
fn lifecycle_allows_pre_dispatch_fail_cancel_skip_and_cache_terminals() {
    for terminal_type in [
        "execution.failed",
        "execution.cancelled",
        "execution.skipped",
        "execution.cache_hit",
    ] {
        let db = migrated_db();
        db.append_ai_audit_events(
            "project-1",
            &[
                event("terminal-start", "execution.started", 1),
                event("terminal", terminal_type, 2),
            ],
        )
        .expect("pre-dispatch terminal is legal for this outcome");
    }
}

#[test]
fn lifecycle_requires_explicit_effective_receipt_after_dispatch_and_allows_retry_terminal() {
    let db = migrated_db();
    db.append_ai_audit_events(
        "project-1",
        &[
            event("effective-start", "execution.started", 1),
            event("effective-initial", "request.prepared", 2),
            event("effective-dispatch", "request.dispatched", 3),
        ],
    )
    .expect("append initial dispatched lifecycle");

    let error = db
        .append_ai_audit_events(
            "project-1",
            &[event("effective-unmarked", "request.prepared", 4)],
        )
        .expect_err("unmarked post-dispatch prepared must fail closed");
    assert!(error.to_string().contains("effectiveRequestReceipt=true"));

    let mut effective = event("effective-marked", "request.prepared", 5);
    effective.payload["effectiveRequestReceipt"] = json!(true);
    db.append_ai_audit_events("project-1", &[effective])
        .expect("explicit effective request receipt is legal after dispatch");
    db.append_ai_audit_events(
        "project-1",
        &[
            event("effective-retrying", "execution.retrying", 6),
            event("effective-failed", "execution.failed", 7),
        ],
    )
    .expect("retry relation may precede the execution terminal");

    let success_db = migrated_db();
    success_db
        .append_ai_audit_events(
            "project-1",
            &[
                event("success-start", "execution.started", 1),
                event("success-prepared", "request.prepared", 2),
                event("success-dispatched", "request.dispatched", 3),
            ],
        )
        .expect("append success precondition");
    let success_error = success_db
        .append_ai_audit_events(
            "project-1",
            &[event("success-too-early", "execution.succeeded", 4)],
        )
        .expect_err("success without a completed response must fail closed");
    assert!(success_error
        .to_string()
        .contains("execution.succeeded requires a durable response.completed event"));
    success_db
        .append_ai_audit_events(
            "project-1",
            &[
                event("success-response", "response.completed", 5),
                event("success-terminal", "execution.succeeded", 6),
            ],
        )
        .expect("completed response permits success terminal");
}

#[test]
fn execution_identity_cannot_change_within_a_scope() {
    let db = migrated_db();
    db.append_ai_audit_events("project-1", &[event("event-start", "execution.started", 1)])
        .expect("append start");
    let mut mismatched = event("event-mismatch", "request.prepared", 2);
    mismatched.operation_id = "different-operation".to_string();

    let error = db
        .append_ai_audit_events("project-1", &[mismatched])
        .expect_err("execution identity drift must fail closed");
    assert!(error.to_string().contains("execution identity mismatch"));
}

#[test]
fn native_dispatch_precondition_requires_exact_ordered_durable_lifecycle_and_identity() {
    let db = migrated_db();
    db.append_ai_audit_events(
        "project-1",
        &[
            event("dispatch-start", "execution.started", 1),
            event("dispatch-prepared", "request.prepared", 2),
            event("dispatch-intent", "request.dispatched", 3),
        ],
    )
    .expect("append renderer lifecycle precondition");

    db.validate_ai_audit_dispatch_precondition(
        Some("project-1"),
        "execution-1",
        "operation-1",
        None,
        "chat.direct",
    )
    .expect("exact durable identity and order permit native dispatch");

    for (operation_id, parent_execution_id, path_id) in [
        ("forged-operation", None, "chat.direct"),
        ("operation-1", Some("forged-parent"), "chat.direct"),
        ("operation-1", None, "agent.direct"),
    ] {
        let error = db
            .validate_ai_audit_dispatch_precondition(
                Some("project-1"),
                "execution-1",
                operation_id,
                parent_execution_id,
                path_id,
            )
            .expect_err("forged durable identity must reject native dispatch");
        assert!(error
            .to_string()
            .contains("AI_AUDIT_DISPATCH_PRECONDITION_FAILED"));
    }

    let wrong_scope = db
        .validate_ai_audit_dispatch_precondition(
            None,
            "execution-1",
            "operation-1",
            None,
            "chat.direct",
        )
        .expect_err("workspace scope cannot authorize a project execution");
    assert!(wrong_scope
        .to_string()
        .contains("AI_AUDIT_DISPATCH_PRECONDITION_FAILED"));
}

#[test]
fn native_dispatch_precondition_rejects_missing_or_out_of_order_events() {
    let missing = migrated_db();
    missing
        .append_ai_audit_events(
            "project-1",
            &[
                event("missing-start", "execution.started", 1),
                event("missing-prepared", "request.prepared", 2),
            ],
        )
        .expect("append incomplete lifecycle");
    let error = missing
        .validate_ai_audit_dispatch_precondition(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "chat.direct",
        )
        .expect_err("missing dispatch intent must reject native dispatch");
    assert!(error
        .to_string()
        .contains("required durable lifecycle is missing or out of order"));

    let out_of_order = migrated_db();
    let append_error = out_of_order
        .append_ai_audit_events(
            "project-1",
            &[
                event("order-start", "execution.started", 1),
                event("order-dispatched", "request.dispatched", 2),
                event("order-prepared", "request.prepared", 3),
            ],
        )
        .expect_err("out-of-order lifecycle must fail at append");
    assert!(append_error
        .to_string()
        .contains("request.dispatched requires a durable pre-dispatch request.prepared"));
    let error = out_of_order
        .validate_ai_audit_dispatch_precondition(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "chat.direct",
        )
        .expect_err("out-of-order lifecycle must reject native dispatch");
    assert!(error
        .to_string()
        .contains("required durable lifecycle is missing or out of order"));
}

#[test]
fn cli_dispatch_claim_is_digest_bound_atomic_and_single_use() {
    let db = migrated_db();
    let mut started = event("cli-start", "execution.started", 1);
    started.path_id = "cli_chat_stream".to_string();
    let mut prepared = event("cli-prepared", "request.prepared", 2);
    prepared.path_id = "cli_chat_stream".to_string();
    prepared.payload = json!({
        "captureState": "partial",
        "credentialsExcluded": true,
        "request": {
            "provider": "cli",
            "model": "gpt-test",
            "messages": [{"role": "user", "content": "hello"}],
            "options": {"cli": "codex"}
        }
    });
    let mut dispatched = event("cli-dispatched", "request.dispatched", 3);
    dispatched.path_id = "cli_chat_stream".to_string();
    db.append_ai_audit_events("project-1", &[started, prepared, dispatched])
        .expect("append CLI lifecycle");

    let result = db
        .claim_cli_ai_audit_dispatch(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "cli_chat_stream",
            &cli_request_sha256(),
        )
        .expect("matching CLI request should claim");
    assert_eq!(result.inserted_count, 1);

    let snapshot = db
        .read_ai_audit_snapshot("project-1", Some(0), None, Some(10))
        .expect("read claimed audit");
    assert_eq!(
        snapshot
            .events
            .last()
            .map(|event| event.event_type.as_str()),
        Some("request.dispatch.claimed")
    );

    let reused = db
        .claim_cli_ai_audit_dispatch(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "cli_chat_stream",
            &cli_request_sha256(),
        )
        .expect_err("one execution may not be claimed twice");
    assert!(reused
        .to_string()
        .contains("execution already has a CLI dispatch claim"));
}

#[test]
fn cli_dispatch_claim_rejects_request_digest_path_and_project_mismatches() {
    let db = migrated_db();
    let mut started = event("cli-start-mismatch", "execution.started", 1);
    started.path_id = "cli_chat_stream".to_string();
    let mut prepared = event("cli-prepared-mismatch", "request.prepared", 2);
    prepared.path_id = "cli_chat_stream".to_string();
    prepared.payload = json!({
        "captureState": "partial",
        "credentialsExcluded": true,
        "request": {
            "provider": "cli",
            "messages": [{"role": "user", "content": "hello"}],
            "options": {"cli": "codex"}
        }
    });
    let mut dispatched = event("cli-dispatched-mismatch", "request.dispatched", 3);
    dispatched.path_id = "cli_chat_stream".to_string();
    db.append_ai_audit_events("project-1", &[started, prepared, dispatched])
        .expect("append CLI lifecycle");

    let digest_mismatch = db
        .claim_cli_ai_audit_dispatch(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "cli_chat_stream",
            &"0".repeat(64),
        )
        .expect_err("forged prompt/model/CLI digest must reject");
    assert!(digest_mismatch
        .to_string()
        .contains("CLI request digest does not match"));

    let path_mismatch = db
        .claim_cli_ai_audit_dispatch(
            Some("project-1"),
            "execution-1",
            "operation-1",
            None,
            "unknown-cli-path",
            &cli_request_sha256(),
        )
        .expect_err("unknown CLI path must reject");
    assert!(path_mismatch
        .to_string()
        .contains("CLI dispatch path is not allowed"));

    let project_mismatch = db
        .claim_cli_ai_audit_dispatch(
            None,
            "execution-1",
            "operation-1",
            None,
            "cli_chat_stream",
            &cli_request_sha256(),
        )
        .expect_err("workspace-scoped CLI dispatch must reject");
    assert!(project_mismatch
        .to_string()
        .contains("CLI dispatch requires a projectId"));
}

#[test]
fn verification_does_not_normalize_tampered_capture_contract_fields() {
    for (field, value) in [
        ("auditSchemaVersion", json!(2)),
        ("recorder", json!("different-recorder")),
        ("appVersion", json!("forged-app-version")),
    ] {
        let db = migrated_db();
        db.append_ai_audit_events("project-1", &[event("event-1", "execution.started", 1)])
            .expect("append audit event");
        let mut payload = db
            .read_ai_audit_snapshot("project-1", None, None, None)
            .expect("read event")
            .events[0]
            .payload
            .clone();
        payload[field] = value;
        let payload = serde_json::to_string(&payload).expect("serialize tampered payload");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE ai_audit_events SET payload = ? WHERE project_id = 'project-1'",
                [&payload],
            )?;
            Ok(())
        })
        .expect("tamper stored payload");

        let result = db
            .verify_ai_audit_chain("project-1", Some(1))
            .expect("verification returns a diagnostic result");
        assert!(!result.ok, "tampering {field} must fail verification");
        assert_eq!(result.broken_at_sequence, Some(1));
    }
}

#[test]
fn project_and_workspace_scopes_are_independent_and_pages_pin_the_tail() {
    let db = migrated_db();
    let project_batch = [
        event("event-1", "execution.started", 1),
        event("event-2", "request.prepared", 2),
        event("event-3", "request.dispatched", 3),
    ];
    db.append_ai_audit_events("project-1", &project_batch)
        .expect("append project chain");
    db.append_ai_audit_events_for_scope(
        None,
        &[
            event("event-1", "execution.started", 4),
            event("event-2", "request.prepared", 5),
        ],
    )
    .expect("append independent workspace chain");

    let first_page = db
        .read_ai_audit_snapshot("project-1", Some(0), None, Some(2))
        .expect("read first project page");
    assert_eq!(first_page.scope_id, "project:project-1");
    assert_eq!(first_page.project_id.as_deref(), Some("project-1"));
    assert_eq!(first_page.high_water_sequence, 3);
    assert_eq!(first_page.next_after_sequence, Some(2));
    assert_eq!(first_page.events.len(), 2);

    db.append_ai_audit_events(
        "project-1",
        &[
            event("event-4", "response.completed", 6),
            event("event-5", "execution.succeeded", 7),
        ],
    )
    .expect("append after high-water selection");
    let pinned_page = db
        .read_ai_audit_snapshot(
            "project-1",
            first_page.next_after_sequence,
            Some(first_page.high_water_sequence),
            Some(2),
        )
        .expect("read pinned second page");
    assert_eq!(pinned_page.events.len(), 1);
    assert_eq!(pinned_page.events[0].event_id, "event-3");
    assert_eq!(pinned_page.next_after_sequence, None);
    assert_eq!(pinned_page.high_water_hash, first_page.high_water_hash);

    let workspace = db
        .read_ai_audit_snapshot_for_scope(None, None, None, Some(2))
        .expect("read workspace chain");
    assert_eq!(workspace.scope_id, "workspace");
    assert_eq!(workspace.project_id, None);
    assert_eq!(workspace.high_water_sequence, 2);
    assert!(
        db.verify_ai_audit_chain_for_scope(None, Some(2))
            .expect("verify workspace chain")
            .ok
    );
}
