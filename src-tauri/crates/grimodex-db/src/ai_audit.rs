//! Forward-only AI execution audit ledger.
//!
//! Audit events deliberately have no scene/message foreign key. Content
//! deletion and project snapshot restore must not erase execution history.
//! Project chains cascade only with their owner; the workspace chain records
//! executions (such as pre-project connection probes) without a project FK.

use std::collections::BTreeMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::Database;

const GENESIS_HASH_HEX: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
pub const AI_AUDIT_SCHEMA_VERSION: i64 = 1;
pub const AI_AUDIT_CAPTURE_CONTRACT_VERSION: i64 = 1;
pub const AI_AUDIT_RECORDER: &str = "grimodex-ai-audit";
pub const AI_AUDIT_DEFAULT_PAGE_SIZE: i64 = 500;
pub const AI_AUDIT_MAX_PAGE_SIZE: i64 = 1_000;
const EVENT_TYPES: &[&str] = &[
    "execution.started",
    "request.prepared",
    "request.dispatched",
    "transport.attempt.started",
    "transport.attempt.finished",
    "response.partial",
    "response.completed",
    "execution.succeeded",
    "execution.failed",
    "execution.cancelled",
    "execution.skipped",
    "execution.cache_hit",
    "execution.retrying",
    "execution.fallback",
];

fn quoted_json_string_end(bytes: &[u8], opening_quote: usize) -> Option<usize> {
    if bytes.get(opening_quote) != Some(&b'"') {
        return None;
    }
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(opening_quote + 1) {
        if escaped {
            escaped = false;
            continue;
        }
        match byte {
            b'\\' => escaped = true,
            b'"' => return Some(index),
            _ => {}
        }
    }
    None
}

fn normalized_credential_key(key: &str) -> String {
    key.chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn segmented_credential_key(key: &str) -> String {
    let mut segmented = String::new();
    let mut previous_was_lower_or_digit = false;
    let mut previous_was_separator = true;
    for character in key.trim().chars() {
        if character.is_ascii_alphanumeric() {
            if character.is_ascii_uppercase()
                && previous_was_lower_or_digit
                && !previous_was_separator
            {
                segmented.push('_');
            }
            segmented.push(character.to_ascii_lowercase());
            previous_was_lower_or_digit =
                character.is_ascii_lowercase() || character.is_ascii_digit();
            previous_was_separator = false;
        } else if !previous_was_separator && !segmented.is_empty() {
            segmented.push('_');
            previous_was_lower_or_digit = false;
            previous_was_separator = true;
        }
    }
    segmented.trim_matches('_').to_string()
}

const STRONG_CREDENTIAL_KEY_MARKERS: &[&str] = &[
    "authorization",
    "authentication",
    "headers",
    "cookie",
    "environment",
    "apikey",
    "accesstoken",
    "bearer",
    "accesskeyid",
    "secretaccesskey",
    "privatekey",
    "password",
    "passwd",
];

fn has_credential_marker_at_key_boundary(normalized: &str, marker: &str) -> bool {
    normalized == marker || normalized.starts_with(marker) || normalized.ends_with(marker)
}

fn safe_token_metric_key(normalized: &str) -> bool {
    const SUFFIXES: &[&str] = &[
        "usage",
        "count",
        "counts",
        "budget",
        "limit",
        "limits",
        "estimate",
        "estimated",
        "total",
        "totals",
        "used",
        "remaining",
        "input",
        "output",
        "cached",
        "reasoning",
        "billable",
    ];
    normalized == "tokens"
        || ["token", "tokens"].into_iter().any(|prefix| {
            normalized
                .strip_prefix(prefix)
                .is_some_and(|suffix| SUFFIXES.contains(&suffix))
        })
}

fn safe_semantic_token_contract_key(normalized: &str) -> bool {
    matches!(
        normalized,
        "tokenizeridentity"
            | "tokenizeridentitystatus"
            | "tokenizeraddsspecialtokens"
            | "tokenizermaytruncateat"
            | "tokenization"
            | "tokenizationcapture"
    )
}

fn is_transport_credential_key(key: &str) -> bool {
    let normalized = normalized_credential_key(key);
    let segmented = segmented_credential_key(key);
    if normalized == "auth"
        || normalized.ends_with("auth")
        || segmented.split('_').any(|segment| segment == "auth")
    {
        return true;
    }
    if STRONG_CREDENTIAL_KEY_MARKERS
        .iter()
        .any(|marker| has_credential_marker_at_key_boundary(&normalized, marker))
    {
        return true;
    }
    if normalized == "env"
        || normalized.starts_with("environment")
        || normalized.starts_with("processenv")
        || normalized.ends_with("env")
    {
        return true;
    }
    if normalized == "secret" || normalized.starts_with("secret") || normalized.ends_with("secret")
    {
        return true;
    }
    normalized == "token"
        || normalized.ends_with("token")
        || (normalized.starts_with("token")
            && !safe_token_metric_key(&normalized)
            && !safe_semantic_token_contract_key(&normalized))
}

const ARRAY_PATH_SEGMENT: &str = "[]";

fn is_declared_ai_visible_path(event_type: &str, path: &[String]) -> bool {
    if event_type == "request.prepared" {
        // Native semantic inference records its exact model input directly at
        // payload.input. Renderer and native provider requests record exact
        // request-body branches under payload.request. A same-named key below
        // metadata/error/diagnostic/options is intentionally not sufficient.
        if path.len() == 1 && path[0] == "input" {
            return true;
        }
        if path.first().is_some_and(|segment| segment == "request") {
            if path.len() == 2
                && ["body", "input", "tools", "modelVisibleContext"].contains(&path[1].as_str())
            {
                return true;
            }
            return path.len() == 3 && path[1] == "messages" && path[2] == ARRAY_PATH_SEGMENT;
        }
    }
    path.len() == 1
        && path[0] == "response"
        && matches!(
            event_type,
            "response.partial" | "response.completed" | "execution.cache_hit"
        )
}

fn is_generated_runtime_diagnostic_path(event_type: &str, path: &[String]) -> bool {
    event_type == "response.partial"
        && path.len() == 2
        && path[0] == "response"
        && path[1] == "runtimeDiagnostic"
}

fn validate_no_transport_credentials(
    value: &Value,
    path: &str,
    event_type: &str,
    json_path: &mut Vec<String>,
    ai_visible: bool,
) -> anyhow::Result<()> {
    match value {
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                json_path.push(ARRAY_PATH_SEGMENT.to_string());
                let child_is_ai_visible =
                    ai_visible || is_declared_ai_visible_path(event_type, json_path);
                validate_no_transport_credentials(
                    item,
                    &format!("{path}[{index}]"),
                    event_type,
                    json_path,
                    child_is_ai_visible,
                )?;
                json_path.pop();
            }
        }
        Value::Object(object) => {
            for (key, child) in object {
                if !ai_visible && is_transport_credential_key(key) {
                    anyhow::bail!("{path}.{key} contains excluded transport credentials");
                }
                json_path.push(key.to_string());
                let child_is_ai_visible =
                    if is_generated_runtime_diagnostic_path(event_type, json_path) {
                        false
                    } else {
                        ai_visible || is_declared_ai_visible_path(event_type, json_path)
                    };
                validate_no_transport_credentials(
                    child,
                    &format!("{path}.{key}"),
                    event_type,
                    json_path,
                    child_is_ai_visible,
                )?;
                json_path.pop();
            }
        }
        _ => {}
    }
    Ok(())
}

/// Redact string values of credential-shaped keys in JSON fragments embedded in a
/// diagnostic. The surrounding diagnostic need not itself be valid JSON. Model output
/// must never be passed here; this helper is only for error/diagnostic boundaries.
pub fn redact_quoted_json_credentials(input: &str) -> String {
    const REPLACEMENT: &str = "\"[REDACTED:credential]\"";
    let mut output = input.to_string();
    let mut search_from = 0usize;

    while search_from < output.len() {
        let Some(relative_quote) = output.as_bytes()[search_from..]
            .iter()
            .position(|byte| *byte == b'"')
        else {
            break;
        };
        let key_start = search_from + relative_quote;
        let Some(key_end) = quoted_json_string_end(output.as_bytes(), key_start) else {
            break;
        };
        let key_token = &output[key_start..=key_end];
        let Ok(key) = serde_json::from_str::<String>(key_token) else {
            search_from = key_end + 1;
            continue;
        };
        let mut cursor = key_end + 1;
        while output
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        if output.as_bytes().get(cursor) != Some(&b':') {
            search_from = key_end + 1;
            continue;
        }
        cursor += 1;
        while output
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        if !is_transport_credential_key(&key) || output.as_bytes().get(cursor) != Some(&b'"') {
            search_from = key_end + 1;
            continue;
        }
        let Some(value_end) = quoted_json_string_end(output.as_bytes(), cursor) else {
            break;
        };
        output.replace_range(cursor..=value_end, REPLACEMENT);
        search_from = cursor + REPLACEMENT.len();
    }

    output
}

fn sanitize_diagnostic_url_token(token: &str) -> String {
    let lowercase = token.to_ascii_lowercase();
    let Some(scheme_start) = lowercase
        .find("https://")
        .or_else(|| lowercase.find("http://"))
    else {
        return token.to_string();
    };
    let candidate = &token[scheme_start..];
    let trimmed = candidate.trim_end_matches([')', ']', '}', ',', ';', ':', '"', '\'']);
    let suffix = &candidate[trimmed.len()..];
    let Some(scheme_end) = trimmed.find("://").map(|index| index + 3) else {
        return token.to_string();
    };
    let authority_end = trimmed[scheme_end..]
        .find(['/', '?', '#'])
        .map(|index| scheme_end + index)
        .unwrap_or(trimmed.len());
    let authority = &trimmed[scheme_end..authority_end];
    if authority.is_empty() {
        return token.to_string();
    }
    let authority_without_userinfo = authority
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(authority);
    if authority_without_userinfo.is_empty() {
        return token.to_string();
    }
    let remainder = &trimmed[authority_end..];
    let sensitive_start = remainder.find(['?', '#']).unwrap_or(remainder.len());
    format!(
        "{}{}{}{}{}",
        &token[..scheme_start],
        &trimmed[..scheme_end],
        authority_without_userinfo,
        &remainder[..sensitive_start],
        suffix
    )
}

fn assignment_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn redact_assignment_credentials(mut input: String) -> String {
    let mut search_from = 0usize;
    while search_from < input.len() {
        let bytes = input.as_bytes();
        let Some(relative_start) = bytes[search_from..]
            .iter()
            .position(|byte| assignment_key_byte(*byte))
        else {
            break;
        };
        let key_start = search_from + relative_start;
        if key_start > 0 && assignment_key_byte(bytes[key_start - 1]) {
            search_from = key_start + 1;
            continue;
        }
        let key_end = bytes[key_start..]
            .iter()
            .position(|byte| !assignment_key_byte(*byte))
            .map(|relative_end| key_start + relative_end)
            .unwrap_or(input.len());
        let key = &input[key_start..key_end];
        let mut cursor = key_end;
        while input
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        if !is_transport_credential_key(key) || input.as_bytes().get(cursor) != Some(&b'=') {
            search_from = key_end.max(key_start + 1);
            continue;
        }
        cursor += 1;
        while input
            .as_bytes()
            .get(cursor)
            .is_some_and(u8::is_ascii_whitespace)
        {
            cursor += 1;
        }
        let value_start = cursor;
        if value_start >= input.len() {
            break;
        }
        let quote = input.as_bytes()[value_start];
        let value_end = if matches!(quote, b'"' | b'\'') {
            let mut escaped = false;
            let mut end = input.len();
            for (relative, byte) in input.as_bytes()[value_start + 1..].iter().enumerate() {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == quote {
                    end = value_start + relative + 2;
                    break;
                }
            }
            end
        } else {
            input.as_bytes()[value_start..]
                .iter()
                .position(|byte| {
                    byte.is_ascii_whitespace()
                        || matches!(*byte, b'&' | b';' | b',' | b')' | b']' | b'}')
                })
                .map(|relative_end| value_start + relative_end)
                .unwrap_or(input.len())
        };
        if value_end == value_start {
            search_from = value_start + 1;
            continue;
        }
        input.replace_range(value_start..value_end, "[REDACTED:credential]");
        search_from = value_start + "[REDACTED:credential]".len();
    }
    input
}

fn redact_marker_values(mut input: String, marker: &str) -> String {
    let mut search_from = 0usize;
    loop {
        let lowercase = input.to_ascii_lowercase();
        let Some(relative) = lowercase[search_from..].find(marker) else {
            break;
        };
        let marker_start = search_from + relative;
        let value_start = marker_start + marker.len();
        let value_end = input[value_start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '&' | ';' | ',' | ')' | ']' | '}')
            })
            .map(|relative_end| value_start + relative_end)
            .unwrap_or(input.len());
        if value_start == value_end {
            search_from = value_start;
            if search_from >= input.len() {
                break;
            }
            continue;
        }
        input.replace_range(marker_start..value_end, "[REDACTED:credential]");
        search_from = marker_start + "[REDACTED:credential]".len();
    }
    input
}

fn redact_credential_headers(mut input: String) -> String {
    let mut line_start = 0usize;
    while line_start < input.len() {
        let line_end = input[line_start..]
            .find(['\r', '\n'])
            .map(|relative| line_start + relative)
            .unwrap_or(input.len());
        let Some(relative_colon) = input[line_start..line_end].find(':') else {
            line_start = (line_end + 1).min(input.len());
            continue;
        };
        let colon = line_start + relative_colon;
        let header_name = input[line_start..colon].trim();
        let header_shape = !header_name.is_empty()
            && header_name.chars().all(|character| {
                character.is_ascii_alphanumeric()
                    || character.is_ascii_whitespace()
                    || matches!(character, '-' | '_' | '.')
            });
        if header_shape && is_transport_credential_key(header_name) {
            let value_start = colon + 1;
            input.replace_range(value_start..line_end, " [REDACTED:credential]");
            line_start = value_start + " [REDACTED:credential]".len();
            while line_start < input.len() && !matches!(input.as_bytes()[line_start], b'\r' | b'\n')
            {
                line_start += 1;
            }
        }
        line_start = (line_start + 1).min(input.len());
    }
    input
}

fn ascii_word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn redact_api_key_tokens(mut input: String) -> String {
    const PREFIX: &[u8] = b"sk-";
    const REPLACEMENT: &str = "[REDACTED:credential]";
    let mut search_from = 0usize;

    while search_from + PREFIX.len() <= input.len() {
        let bytes = input.as_bytes();
        let Some(relative_start) = bytes[search_from..]
            .windows(PREFIX.len())
            .position(|window| window == PREFIX)
        else {
            break;
        };
        let token_start = search_from + relative_start;
        if token_start > 0 && ascii_word_byte(bytes[token_start - 1]) {
            search_from = token_start + PREFIX.len();
            continue;
        }

        let mut token_end = token_start + PREFIX.len();
        while input
            .as_bytes()
            .get(token_end)
            .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            token_end += 1;
        }
        while token_end > token_start + PREFIX.len()
            && !ascii_word_byte(input.as_bytes()[token_end - 1])
        {
            token_end -= 1;
        }
        if token_end - (token_start + PREFIX.len()) < 8 {
            search_from = token_start + PREFIX.len();
            continue;
        }

        input.replace_range(token_start..token_end, REPLACEMENT);
        search_from = token_start + REPLACEMENT.len();
    }

    input
}

/// Sanitize provider/transport diagnostics before they cross an IPC or durable
/// audit boundary. This strips URL user-info/query/fragment plus JSON,
/// assignment, bearer, provider API-key tokens, and header-shaped credentials.
/// Model output must never be passed to this diagnostic-only boundary.
pub fn sanitize_diagnostic_credentials(input: &str) -> String {
    let sanitized_urls: String = input
        .split_inclusive(char::is_whitespace)
        .map(|piece| {
            let content = piece.trim_end_matches(char::is_whitespace);
            let whitespace = &piece[content.len()..];
            format!("{}{}", sanitize_diagnostic_url_token(content), whitespace)
        })
        .collect();
    let sanitized_json = redact_quoted_json_credentials(&sanitized_urls);
    let sanitized_assignments = redact_assignment_credentials(sanitized_json);
    let sanitized_bearer = redact_marker_values(sanitized_assignments, "bearer ");
    let sanitized_api_key_tokens = redact_api_key_tokens(sanitized_bearer);
    redact_credential_headers(sanitized_api_key_tokens)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendAiAuditEvent {
    pub event_id: String,
    pub execution_id: String,
    pub operation_id: String,
    pub parent_execution_id: Option<String>,
    pub path_id: String,
    pub event_type: String,
    pub timestamp: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditAppendResult {
    pub inserted_count: usize,
    pub tail_sequence: i64,
    pub tail_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditEvent {
    pub sequence: i64,
    pub event_id: String,
    pub scope_id: String,
    pub project_id: Option<String>,
    pub execution_id: String,
    pub operation_id: String,
    pub parent_execution_id: Option<String>,
    pub path_id: String,
    pub event_type: String,
    pub timestamp: i64,
    pub recorded_at: i64,
    pub payload: Value,
    pub payload_sha256: String,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditSnapshot {
    pub scope_id: String,
    pub project_id: Option<String>,
    pub after_sequence: i64,
    pub high_water_sequence: i64,
    pub high_water_hash: String,
    pub next_after_sequence: Option<i64>,
    pub events: Vec<AiAuditEvent>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditVerifyResult {
    pub ok: bool,
    pub verified_through_sequence: i64,
    pub broken_at_sequence: Option<i64>,
    pub reason: Option<String>,
    pub tail_hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashInput<'a> {
    scope_id: &'a str,
    project_id: Option<&'a str>,
    sequence: i64,
    event_id: &'a str,
    execution_id: &'a str,
    operation_id: &'a str,
    parent_execution_id: Option<&'a str>,
    path_id: &'a str,
    event_type: &'a str,
    timestamp: i64,
    recorded_at: i64,
    payload_sha256: &'a str,
    prev_hash: &'a str,
}

fn canonical_json_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonical_json_value).collect()),
        Value::Object(map) => {
            let sorted: BTreeMap<_, _> = map
                .iter()
                .map(|(key, value)| (key.clone(), canonical_json_value(value)))
                .collect();
            Value::Object(sorted.into_iter().collect())
        }
        _ => value.clone(),
    }
}

fn enrich_payload_for_append(payload: &Value) -> anyhow::Result<Value> {
    let mut enriched = payload
        .as_object()
        .context("payload must be a JSON object")?
        .clone();
    enriched.insert(
        "auditSchemaVersion".to_string(),
        Value::from(AI_AUDIT_SCHEMA_VERSION),
    );
    enriched.insert(
        "captureContractVersion".to_string(),
        Value::from(AI_AUDIT_CAPTURE_CONTRACT_VERSION),
    );
    enriched.insert(
        "recorder".to_string(),
        Value::String(AI_AUDIT_RECORDER.to_string()),
    );
    let app_version = enriched
        .get("appVersion")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("unknown")
        .to_string();
    enriched.insert("appVersion".to_string(), Value::String(app_version));
    Ok(Value::Object(enriched))
}

fn canonical_stored_payload(payload: &Value) -> anyhow::Result<String> {
    payload
        .as_object()
        .context("payload must be a JSON object")?;
    serde_json::to_string(&canonical_json_value(payload)).context("serialize AI audit payload")
}

fn canonical_payload_for_append(payload: &Value) -> anyhow::Result<String> {
    canonical_stored_payload(&enrich_payload_for_append(payload)?)
}

fn validate_stored_capture_contract(payload: &Value) -> anyhow::Result<()> {
    let payload = payload
        .as_object()
        .context("payload must be a JSON object")?;
    anyhow::ensure!(
        payload.get("auditSchemaVersion").and_then(Value::as_i64) == Some(AI_AUDIT_SCHEMA_VERSION),
        "payload.auditSchemaVersion is unsupported"
    );
    anyhow::ensure!(
        payload
            .get("captureContractVersion")
            .and_then(Value::as_i64)
            == Some(AI_AUDIT_CAPTURE_CONTRACT_VERSION),
        "payload.captureContractVersion is unsupported"
    );
    anyhow::ensure!(
        payload.get("recorder").and_then(Value::as_str) == Some(AI_AUDIT_RECORDER),
        "payload.recorder is unsupported"
    );
    anyhow::ensure!(
        payload
            .get("appVersion")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty()),
        "payload.appVersion is required"
    );
    Ok(())
}

fn sha256_hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(bytes.as_ref()))
}

fn compute_hash(input: HashInput<'_>) -> anyhow::Result<String> {
    let bytes = serde_json::to_vec(&input).context("serialize AI audit hash body")?;
    Ok(sha256_hex(bytes))
}

fn recorded_at_now_ms() -> anyhow::Result<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before Unix epoch")?
        .as_millis();
    i64::try_from(millis).context("system clock milliseconds exceed i64")
}

pub fn ai_audit_scope_id(project_id: Option<&str>) -> anyhow::Result<String> {
    match project_id {
        Some(project_id) => {
            anyhow::ensure!(!project_id.trim().is_empty(), "projectId must be non-empty");
            anyhow::ensure!(
                project_id == project_id.trim(),
                "projectId must not contain surrounding whitespace"
            );
            Ok(format!("project:{project_id}"))
        }
        None => Ok("workspace".to_string()),
    }
}

fn validate_event(event: &AppendAiAuditEvent) -> anyhow::Result<()> {
    for (name, value) in [
        ("eventId", event.event_id.as_str()),
        ("executionId", event.execution_id.as_str()),
        ("operationId", event.operation_id.as_str()),
        ("pathId", event.path_id.as_str()),
        ("eventType", event.event_type.as_str()),
    ] {
        anyhow::ensure!(!value.trim().is_empty(), "{name} is required");
    }
    anyhow::ensure!(event.timestamp >= 0, "timestamp must be non-negative");
    anyhow::ensure!(
        EVENT_TYPES.contains(&event.event_type.as_str()),
        "unsupported AI audit eventType"
    );
    let payload = event
        .payload
        .as_object()
        .context("payload must be a JSON object")?;
    let capture_state = payload
        .get("captureState")
        .and_then(Value::as_str)
        .context("payload.captureState is required")?;
    anyhow::ensure!(
        matches!(
            capture_state,
            "complete"
                | "partial"
                | "redacted"
                | "truncated"
                | "legacy_missing"
                | "unobservable_provider"
        ),
        "unsupported payload.captureState"
    );
    validate_no_transport_credentials(
        &event.payload,
        "payload",
        &event.event_type,
        &mut Vec::new(),
        false,
    )?;
    if event.event_type == "request.prepared" {
        anyhow::ensure!(
            payload.get("credentialsExcluded").and_then(Value::as_bool) == Some(true),
            "request.prepared requires payload.credentialsExcluded=true"
        );
    }
    if let Some(redactions) = payload.get("redactions") {
        let redactions = redactions
            .as_array()
            .context("payload.redactions must be an array")?;
        for redaction in redactions {
            let redaction = redaction
                .as_object()
                .context("payload.redactions entries must be objects")?;
            let non_empty_string = |key: &str| {
                redaction
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .with_context(|| format!("payload.redactions.{key} is required"))
            };
            let original_sha256 = non_empty_string("originalSha256")?;
            anyhow::ensure!(
                original_sha256.len() == 64
                    && original_sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "payload.redactions.originalSha256 must be lowercase SHA-256 hex"
            );
            non_empty_string("path")?;
            non_empty_string("ruleId")?;
            anyhow::ensure!(
                redaction.get("category").and_then(Value::as_str) == Some("credential"),
                "payload.redactions.category must be credential"
            );
            anyhow::ensure!(
                redaction
                    .get("originalByteLength")
                    .and_then(Value::as_u64)
                    .is_some(),
                "payload.redactions.originalByteLength must be a non-negative integer"
            );
            anyhow::ensure!(
                redaction.get("placeholder").and_then(Value::as_str)
                    == Some("[REDACTED:credential]"),
                "payload.redactions.placeholder is invalid"
            );
            anyhow::ensure!(
                redaction.get("reversible").and_then(Value::as_bool) == Some(false),
                "payload.redactions.reversible must be false"
            );
        }
    }
    Ok(())
}

fn current_tail(conn: &Connection, scope_id: &str) -> anyhow::Result<(i64, String)> {
    Ok(conn
        .query_row(
            "SELECT sequence, hash FROM ai_audit_events
             WHERE scope_id = ? ORDER BY sequence DESC LIMIT 1",
            params![scope_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_else(|| (0, GENESIS_HASH_HEX.to_string())))
}

#[derive(Debug, PartialEq, Eq)]
struct ExistingEventFingerprint {
    execution_id: String,
    operation_id: String,
    parent_execution_id: Option<String>,
    path_id: String,
    event_type: String,
    timestamp: i64,
    payload_sha256: String,
}

fn existing_event_fingerprint(
    conn: &Connection,
    scope_id: &str,
    event_id: &str,
) -> anyhow::Result<Option<ExistingEventFingerprint>> {
    Ok(conn
        .query_row(
            "SELECT execution_id, operation_id, parent_execution_id, path_id,
                    event_type, timestamp, payload_sha256
             FROM ai_audit_events WHERE scope_id = ? AND event_id = ?",
            params![scope_id, event_id],
            |row| {
                Ok(ExistingEventFingerprint {
                    execution_id: row.get(0)?,
                    operation_id: row.get(1)?,
                    parent_execution_id: row.get(2)?,
                    path_id: row.get(3)?,
                    event_type: row.get(4)?,
                    timestamp: row.get(5)?,
                    payload_sha256: row.get(6)?,
                })
            },
        )
        .optional()?)
}

#[derive(Debug, PartialEq, Eq)]
struct ExistingExecutionIdentity {
    operation_id: String,
    parent_execution_id: Option<String>,
    path_id: String,
    started: bool,
    prepared_before_dispatch: bool,
    dispatched: bool,
    response_completed: bool,
    terminal_event_type: Option<String>,
}

fn existing_execution_identity(
    conn: &Connection,
    scope_id: &str,
    execution_id: &str,
) -> anyhow::Result<Option<ExistingExecutionIdentity>> {
    let identity = conn
        .query_row(
            "SELECT operation_id, parent_execution_id, path_id
               FROM ai_audit_events
              WHERE scope_id = ? AND execution_id = ?
              ORDER BY sequence ASC LIMIT 1",
            params![scope_id, execution_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((operation_id, parent_execution_id, path_id)) = identity else {
        return Ok(None);
    };
    // Ignore the potentially large response.partial/transport-attempt stream;
    // only lifecycle boundary rows are needed to validate the next append.
    let mut statement = conn.prepare(
        "SELECT event_type
           FROM ai_audit_events
          WHERE scope_id = ? AND execution_id = ?
            AND event_type IN (
                'execution.started', 'request.prepared', 'request.dispatched',
                'response.completed', 'execution.succeeded', 'execution.failed',
                'execution.cancelled', 'execution.skipped', 'execution.cache_hit'
            )
          ORDER BY sequence ASC",
    )?;
    let mut rows = statement.query(params![scope_id, execution_id])?;
    let mut started = false;
    let mut prepared_before_dispatch = false;
    let mut dispatched = false;
    let mut response_completed = false;
    let mut terminal_event_type = None;
    let mut observe = |event_type: String| match event_type.as_str() {
        "execution.started" => started = true,
        "request.prepared" if !dispatched => prepared_before_dispatch = true,
        "request.dispatched" => dispatched = true,
        "response.completed" => response_completed = true,
        "execution.succeeded"
        | "execution.failed"
        | "execution.cancelled"
        | "execution.skipped"
        | "execution.cache_hit" => {
            if terminal_event_type.is_none() {
                terminal_event_type = Some(event_type);
            }
        }
        _ => {}
    };
    while let Some(row) = rows.next()? {
        observe(row.get::<_, String>(0)?);
    }
    Ok(Some(ExistingExecutionIdentity {
        operation_id,
        parent_execution_id,
        path_id,
        started,
        prepared_before_dispatch,
        dispatched,
        response_completed,
        terminal_event_type,
    }))
}

fn validate_ai_audit_lifecycle_transition(
    existing: Option<&ExistingExecutionIdentity>,
    event: &AppendAiAuditEvent,
) -> anyhow::Result<()> {
    let Some(existing) = existing else {
        anyhow::ensure!(
            event.event_type == "execution.started",
            "AI audit execution must begin with execution.started: {}",
            event.execution_id
        );
        return Ok(());
    };
    anyhow::ensure!(
        existing.started,
        "AI audit execution has no leading execution.started event: {}",
        event.execution_id
    );

    match event.event_type.as_str() {
        "execution.started" => anyhow::bail!(
            "AI audit execution already has execution.started: {}",
            event.execution_id
        ),
        "request.prepared" => {
            if existing.dispatched {
                anyhow::ensure!(
                    event
                        .payload
                        .get("effectiveRequestReceipt")
                        .and_then(Value::as_bool)
                        == Some(true),
                    "post-dispatch request.prepared requires payload.effectiveRequestReceipt=true"
                );
            }
        }
        "request.dispatched" => {
            anyhow::ensure!(
                existing.prepared_before_dispatch,
                "request.dispatched requires a durable pre-dispatch request.prepared"
            );
            anyhow::ensure!(
                !existing.dispatched,
                "AI audit execution already has request.dispatched: {}",
                event.execution_id
            );
        }
        "transport.attempt.started"
        | "transport.attempt.finished"
        | "response.partial"
        | "response.completed"
        | "execution.retrying"
        | "execution.fallback" => {
            anyhow::ensure!(
                existing.dispatched,
                "{} requires a durable request.dispatched event",
                event.event_type
            );
        }
        "execution.succeeded" => {
            anyhow::ensure!(
                existing.dispatched,
                "execution.succeeded requires a durable request.dispatched event"
            );
            anyhow::ensure!(
                existing.response_completed,
                "execution.succeeded requires a durable response.completed event"
            );
        }
        "execution.failed" | "execution.cancelled" => {
            // Provider setup, pre-dispatch persistence, cancellation, or unwind
            // can terminate after start without ever claiming a model dispatch.
        }
        "execution.skipped" | "execution.cache_hit" => {
            anyhow::ensure!(
                !existing.dispatched,
                "{} must not follow request.dispatched",
                event.event_type
            );
        }
        _ => unreachable!("validate_event rejects unsupported event types"),
    }
    Ok(())
}

pub fn append_ai_audit_events_for_scope(
    conn: &Connection,
    project_id: Option<&str>,
    events: &[AppendAiAuditEvent],
) -> anyhow::Result<AiAuditAppendResult> {
    let scope_id = ai_audit_scope_id(project_id)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| {
        let (mut sequence, mut prev_hash) = current_tail(conn, &scope_id)?;
        let mut inserted_count = 0usize;

        for event in events {
            validate_event(event)?;
            let payload = canonical_payload_for_append(&event.payload)?;
            let payload_sha256 = sha256_hex(payload.as_bytes());
            if let Some(existing) = existing_event_fingerprint(conn, &scope_id, &event.event_id)? {
                let expected = ExistingEventFingerprint {
                    execution_id: event.execution_id.clone(),
                    operation_id: event.operation_id.clone(),
                    parent_execution_id: event.parent_execution_id.clone(),
                    path_id: event.path_id.clone(),
                    event_type: event.event_type.clone(),
                    timestamp: event.timestamp,
                    payload_sha256: payload_sha256.clone(),
                };
                anyhow::ensure!(
                    existing == expected,
                    "eventId collision with different AI audit payload: {}",
                    event.event_id
                );
                continue;
            }

            let existing = existing_execution_identity(conn, &scope_id, &event.execution_id)?;
            if let Some(existing) = existing.as_ref() {
                anyhow::ensure!(
                    existing.operation_id == event.operation_id
                        && existing.parent_execution_id == event.parent_execution_id
                        && existing.path_id == event.path_id,
                    "execution identity mismatch for AI audit execution: {}",
                    event.execution_id
                );
                anyhow::ensure!(
                    existing.terminal_event_type.is_none(),
                    "AI audit execution already reached terminal event {}: {}",
                    existing.terminal_event_type.as_deref().unwrap_or("unknown"),
                    event.execution_id
                );
            }
            validate_ai_audit_lifecycle_transition(existing.as_ref(), event)?;

            sequence += 1;
            let recorded_at = recorded_at_now_ms()?;
            let hash = compute_hash(HashInput {
                scope_id: &scope_id,
                project_id,
                sequence,
                event_id: &event.event_id,
                execution_id: &event.execution_id,
                operation_id: &event.operation_id,
                parent_execution_id: event.parent_execution_id.as_deref(),
                path_id: &event.path_id,
                event_type: &event.event_type,
                timestamp: event.timestamp,
                recorded_at,
                payload_sha256: &payload_sha256,
                prev_hash: &prev_hash,
            })?;
            conn.execute(
                "INSERT INTO ai_audit_events
                 (scope_id, project_id, sequence, event_id, execution_id, operation_id,
                 parent_execution_id, path_id, event_type, timestamp, recorded_at,
                  payload, payload_sha256, prev_hash, hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    scope_id,
                    project_id,
                    sequence,
                    event.event_id,
                    event.execution_id,
                    event.operation_id,
                    event.parent_execution_id,
                    event.path_id,
                    event.event_type,
                    event.timestamp,
                    recorded_at,
                    payload,
                    payload_sha256,
                    prev_hash,
                    hash,
                ],
            )?;
            prev_hash = hash;
            inserted_count += 1;
        }

        Ok(AiAuditAppendResult {
            inserted_count,
            tail_sequence: sequence,
            tail_hash: prev_hash,
        })
    })();

    match result {
        Ok(result) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                return Err(error.into());
            }
            Ok(result)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Fail-closed proof that a native provider dispatch is correlated to the
/// renderer's already-durable lifecycle precondition. Direct N-API callers
/// cannot create a second, unaudited execution by supplying correlation IDs
/// alone: the exact scope/execution identity and ordered start/prepared/
/// dispatched events must already exist in the pinned workspace database.
pub fn validate_ai_audit_dispatch_precondition(
    conn: &Connection,
    project_id: Option<&str>,
    execution_id: &str,
    operation_id: &str,
    parent_execution_id: Option<&str>,
    path_id: &str,
) -> anyhow::Result<()> {
    const REQUIRED: [&str; 3] = [
        "execution.started",
        "request.prepared",
        "request.dispatched",
    ];
    let scope_id = ai_audit_scope_id(project_id)?;
    let mut statement = conn.prepare(
        "SELECT event_type, operation_id, parent_execution_id, path_id
           FROM ai_audit_events
          WHERE scope_id = ? AND execution_id = ?
            AND event_type IN ('execution.started', 'request.prepared', 'request.dispatched')
          ORDER BY sequence ASC",
    )?;
    let rows = statement.query_map(params![scope_id, execution_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut observed = Vec::new();
    for row in rows {
        let (event_type, stored_operation_id, stored_parent_execution_id, stored_path_id) = row?;
        anyhow::ensure!(
            stored_operation_id == operation_id
                && stored_parent_execution_id.as_deref() == parent_execution_id
                && stored_path_id == path_id,
            "AI_AUDIT_DISPATCH_PRECONDITION_FAILED: durable execution identity mismatch"
        );
        observed.push(event_type);
    }
    anyhow::ensure!(
        observed == REQUIRED,
        "AI_AUDIT_DISPATCH_PRECONDITION_FAILED: required durable lifecycle is missing or out of order"
    );
    Ok(())
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiAuditEvent> {
    let payload: String = row.get(11)?;
    let payload = serde_json::from_str(&payload).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(11, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(AiAuditEvent {
        sequence: row.get(0)?,
        event_id: row.get(1)?,
        scope_id: row.get(2)?,
        project_id: row.get(3)?,
        execution_id: row.get(4)?,
        operation_id: row.get(5)?,
        parent_execution_id: row.get(6)?,
        path_id: row.get(7)?,
        event_type: row.get(8)?,
        timestamp: row.get(9)?,
        recorded_at: row.get(10)?,
        payload,
        payload_sha256: row.get(12)?,
        prev_hash: row.get(13)?,
        hash: row.get(14)?,
    })
}

pub fn read_ai_audit_snapshot_for_scope(
    conn: &Connection,
    project_id: Option<&str>,
    after_sequence: Option<i64>,
    high_water_sequence: Option<i64>,
    limit: Option<i64>,
) -> anyhow::Result<AiAuditSnapshot> {
    let scope_id = ai_audit_scope_id(project_id)?;
    let after_sequence = after_sequence.unwrap_or(0);
    let limit = limit.unwrap_or(AI_AUDIT_DEFAULT_PAGE_SIZE);
    anyhow::ensure!(after_sequence >= 0, "afterSequence must be non-negative");
    anyhow::ensure!(
        (1..=AI_AUDIT_MAX_PAGE_SIZE).contains(&limit),
        "limit must be between 1 and {AI_AUDIT_MAX_PAGE_SIZE}"
    );
    let (tail_sequence, tail_hash) = current_tail(conn, &scope_id)?;
    let high_water_sequence = high_water_sequence.unwrap_or(tail_sequence);
    anyhow::ensure!(
        high_water_sequence >= after_sequence,
        "highWaterSequence must be >= afterSequence"
    );
    anyhow::ensure!(
        high_water_sequence <= tail_sequence,
        "highWaterSequence exceeds current tail"
    );
    let high_water_hash = if high_water_sequence == tail_sequence {
        tail_hash
    } else if high_water_sequence == 0 {
        GENESIS_HASH_HEX.to_string()
    } else {
        conn.query_row(
            "SELECT hash FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
            params![scope_id, high_water_sequence],
            |row| row.get(0),
        )
        .optional()?
        .context("high-water event is missing")?
    };

    let mut statement = conn.prepare(
        "SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                parent_execution_id, path_id, event_type, timestamp, recorded_at,
                payload, payload_sha256, prev_hash, hash
         FROM ai_audit_events
         WHERE scope_id = ? AND sequence > ? AND sequence <= ?
         ORDER BY sequence ASC
         LIMIT ?",
    )?;
    let events = statement
        .query_map(
            params![scope_id, after_sequence, high_water_sequence, limit],
            event_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    let next_after_sequence = events.last().and_then(|event| {
        (events.len() == limit as usize && event.sequence < high_water_sequence)
            .then_some(event.sequence)
    });

    Ok(AiAuditSnapshot {
        scope_id,
        project_id: project_id.map(ToString::to_string),
        after_sequence,
        high_water_sequence,
        high_water_hash,
        next_after_sequence,
        events,
    })
}

pub fn verify_ai_audit_chain_for_scope(
    conn: &Connection,
    project_id: Option<&str>,
    high_water_sequence: Option<i64>,
) -> anyhow::Result<AiAuditVerifyResult> {
    let scope_id = ai_audit_scope_id(project_id)?;
    let (tail_sequence, tail_hash) = current_tail(conn, &scope_id)?;
    let high_water_sequence = high_water_sequence.unwrap_or(tail_sequence);
    anyhow::ensure!(
        (0..=tail_sequence).contains(&high_water_sequence),
        "highWaterSequence exceeds current tail"
    );
    let high_water_hash = if high_water_sequence == tail_sequence {
        tail_hash
    } else if high_water_sequence == 0 {
        GENESIS_HASH_HEX.to_string()
    } else {
        conn.query_row(
            "SELECT hash FROM ai_audit_events WHERE scope_id = ? AND sequence = ?",
            params![scope_id, high_water_sequence],
            |row| row.get(0),
        )
        .optional()?
        .context("high-water event is missing")?
    };
    let mut expected_sequence = 1i64;
    let mut prev_hash = GENESIS_HASH_HEX.to_string();
    let mut statement = conn.prepare(
        "SELECT sequence, event_id, scope_id, project_id, execution_id, operation_id,
                parent_execution_id, path_id, event_type, timestamp, recorded_at,
                payload, payload_sha256, prev_hash, hash
         FROM ai_audit_events
         WHERE scope_id = ? AND sequence <= ?
         ORDER BY sequence ASC",
    )?;
    let rows = statement.query_map(params![scope_id, high_water_sequence], event_from_row)?;

    for row in rows {
        let event = row?;
        let broken = |reason: String| AiAuditVerifyResult {
            ok: false,
            verified_through_sequence: expected_sequence - 1,
            broken_at_sequence: Some(expected_sequence),
            reason: Some(reason),
            tail_hash: high_water_hash.clone(),
        };
        if event.sequence != expected_sequence {
            return Ok(broken(format!(
                "sequence gap: expected {expected_sequence}, found {}",
                event.sequence
            )));
        }
        if event.prev_hash != prev_hash {
            return Ok(broken("prevHash mismatch".to_string()));
        }
        if let Err(error) = validate_stored_capture_contract(&event.payload) {
            return Ok(broken(format!("stored payload contract mismatch: {error}")));
        }
        let payload = match canonical_stored_payload(&event.payload) {
            Ok(payload) => payload,
            Err(error) => {
                return Ok(broken(format!("stored payload is invalid: {error}")));
            }
        };
        let payload_sha256 = sha256_hex(payload.as_bytes());
        if event.payload_sha256 != payload_sha256 {
            return Ok(broken("payloadSha256 mismatch".to_string()));
        }
        let hash = compute_hash(HashInput {
            scope_id: &event.scope_id,
            project_id: event.project_id.as_deref(),
            sequence: event.sequence,
            event_id: &event.event_id,
            execution_id: &event.execution_id,
            operation_id: &event.operation_id,
            parent_execution_id: event.parent_execution_id.as_deref(),
            path_id: &event.path_id,
            event_type: &event.event_type,
            timestamp: event.timestamp,
            recorded_at: event.recorded_at,
            payload_sha256: &event.payload_sha256,
            prev_hash: &event.prev_hash,
        })?;
        if event.hash != hash {
            return Ok(broken("hash mismatch".to_string()));
        }
        prev_hash = event.hash;
        expected_sequence += 1;
    }

    if expected_sequence - 1 != high_water_sequence {
        return Ok(AiAuditVerifyResult {
            ok: false,
            verified_through_sequence: expected_sequence - 1,
            broken_at_sequence: Some(expected_sequence),
            reason: Some("sequence gap before pinned high-water mark".to_string()),
            tail_hash: high_water_hash,
        });
    }

    Ok(AiAuditVerifyResult {
        ok: true,
        verified_through_sequence: high_water_sequence,
        broken_at_sequence: None,
        reason: None,
        tail_hash: high_water_hash,
    })
}

impl Database {
    pub fn append_ai_audit_events(
        &self,
        project_id: &str,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<AiAuditAppendResult> {
        self.append_ai_audit_events_for_scope(Some(project_id), events)
    }

    pub fn append_ai_audit_events_for_scope(
        &self,
        project_id: Option<&str>,
        events: &[AppendAiAuditEvent],
    ) -> anyhow::Result<AiAuditAppendResult> {
        self.with_conn(|conn| append_ai_audit_events_for_scope(conn, project_id, events))
    }

    pub fn validate_ai_audit_dispatch_precondition(
        &self,
        project_id: Option<&str>,
        execution_id: &str,
        operation_id: &str,
        parent_execution_id: Option<&str>,
        path_id: &str,
    ) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            validate_ai_audit_dispatch_precondition(
                conn,
                project_id,
                execution_id,
                operation_id,
                parent_execution_id,
                path_id,
            )
        })
    }

    pub fn read_ai_audit_snapshot(
        &self,
        project_id: &str,
        after_sequence: Option<i64>,
        high_water_sequence: Option<i64>,
        limit: Option<i64>,
    ) -> anyhow::Result<AiAuditSnapshot> {
        self.read_ai_audit_snapshot_for_scope(
            Some(project_id),
            after_sequence,
            high_water_sequence,
            limit,
        )
    }

    pub fn read_ai_audit_snapshot_for_scope(
        &self,
        project_id: Option<&str>,
        after_sequence: Option<i64>,
        high_water_sequence: Option<i64>,
        limit: Option<i64>,
    ) -> anyhow::Result<AiAuditSnapshot> {
        self.with_conn(|conn| {
            read_ai_audit_snapshot_for_scope(
                conn,
                project_id,
                after_sequence,
                high_water_sequence,
                limit,
            )
        })
    }

    pub fn verify_ai_audit_chain(
        &self,
        project_id: &str,
        high_water_sequence: Option<i64>,
    ) -> anyhow::Result<AiAuditVerifyResult> {
        self.verify_ai_audit_chain_for_scope(Some(project_id), high_water_sequence)
    }

    pub fn verify_ai_audit_chain_for_scope(
        &self,
        project_id: Option<&str>,
        high_water_sequence: Option<i64>,
    ) -> anyhow::Result<AiAuditVerifyResult> {
        self.with_conn(|conn| {
            verify_ai_audit_chain_for_scope(conn, project_id, high_water_sequence)
        })
    }
}
