//! Reserved audit namespace of the NIR-1 local generation routes (K5/3, S17).
//!
//! The two local generation paths and the IDs derived from an attempt live in
//! a namespace that only the Native audit owner and its sweep may write. The
//! generic append (`append_ai_audit_events_for_scope`, and through it the
//! N-API `ai_audit_append_batch` that the renderer reaches) rejects any batch
//! that carries a reserved path ID or a reserved ID, writing nothing. The
//! dedicated append in this module is `pub(crate)`: the privilege is the
//! function entry, so neither the renderer nor an N-API argument can choose it.
//!
//! The same constants are mirrored by `electron/shared/nir1LocalAuditNamespace.ts`;
//! a vitest reads this file to detect drift.

use std::fmt;

use anyhow::Context;
use rusqlite::Connection;

use crate::ai_audit::{
    append_ai_audit_events_in_transaction, AiAuditAppendResult, AppendAiAuditEvent,
};

/// Every reserved eventId, executionId, operationId and parentExecutionId
/// starts with this prefix.
pub const NIR1_LOCAL_AUDIT_ID_PREFIX: &str = "nir1-local-generation:";
pub const NIR1_LOCAL_WRITING_PATH_ID: &str = "nir1_local_generation_writing";
pub const NIR1_LOCAL_REVIEW_PATH_ID: &str = "nir1_local_generation_review";
pub const NIR1_LOCAL_AUDIT_PATH_IDS: [&str; 2] =
    [NIR1_LOCAL_WRITING_PATH_ID, NIR1_LOCAL_REVIEW_PATH_ID];

const EXECUTION_KIND: &str = "execution";
const OPERATION_KIND: &str = "operation";
const EVENT_KIND: &str = "event";
const MAX_ATTEMPT_ID_BYTES: usize = 128;

/// A generic append carried a reserved path ID or ID. Nothing was written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Nir1LocalAuditReservedError {
    pub event_index: usize,
    pub field: &'static str,
}

impl fmt::Display for Nir1LocalAuditReservedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "AI_AUDIT_RESERVED_NAMESPACE: events[{}].{} is reserved for the NIR-1 local generation audit owner",
            self.event_index, self.field
        )
    }
}

impl std::error::Error for Nir1LocalAuditReservedError {}

fn starts_with_prefix_ignoring_ascii_case(value: &str) -> bool {
    let prefix = NIR1_LOCAL_AUDIT_ID_PREFIX.as_bytes();
    let bytes = value.trim().as_bytes();
    bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// Whether an eventId, executionId, operationId or parentExecutionId is in the
/// reserved namespace. Surrounding whitespace and ASCII case do not hide it.
pub fn is_reserved_id(value: &str) -> bool {
    starts_with_prefix_ignoring_ascii_case(value)
}

/// Whether a path ID is one of the two reserved local generation paths
/// (same normalization as [`is_reserved_id`]).
pub fn is_reserved_path_id(value: &str) -> bool {
    let value = value.trim();
    NIR1_LOCAL_AUDIT_PATH_IDS
        .iter()
        .any(|path| value.eq_ignore_ascii_case(path))
}

/// The first reserved field of an event, if any.
pub fn reserved_field(event: &AppendAiAuditEvent) -> Option<&'static str> {
    if is_reserved_path_id(&event.path_id) {
        return Some("pathId");
    }
    if is_reserved_id(&event.event_id) {
        return Some("eventId");
    }
    if is_reserved_id(&event.execution_id) {
        return Some("executionId");
    }
    if is_reserved_id(&event.operation_id) {
        return Some("operationId");
    }
    if event
        .parent_execution_id
        .as_deref()
        .is_some_and(is_reserved_id)
    {
        return Some("parentExecutionId");
    }
    None
}

pub fn is_reserved_event(event: &AppendAiAuditEvent) -> bool {
    reserved_field(event).is_some()
}

/// Reject the whole batch when any event is reserved (checked before any
/// transaction is opened).
pub fn reject_reserved_events(
    events: &[AppendAiAuditEvent],
) -> Result<(), Nir1LocalAuditReservedError> {
    for (event_index, event) in events.iter().enumerate() {
        if let Some(field) = reserved_field(event) {
            return Err(Nir1LocalAuditReservedError { event_index, field });
        }
    }
    Ok(())
}

fn valid_attempt_id(attempt_id: &str) -> bool {
    !attempt_id.is_empty()
        && attempt_id.len() <= MAX_ATTEMPT_ID_BYTES
        && attempt_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn derived(kind: &str, attempt_id: &str, suffix: Option<&str>) -> String {
    match suffix {
        Some(suffix) => format!("{NIR1_LOCAL_AUDIT_ID_PREFIX}{kind}:{attempt_id}:{suffix}"),
        None => format!("{NIR1_LOCAL_AUDIT_ID_PREFIX}{kind}:{attempt_id}"),
    }
}

/// Execution ID of the attempt. Deterministic, so the sweep resolves an
/// attempt's execution exactly without any stored column.
pub fn execution_id_for_attempt(attempt_id: &str) -> anyhow::Result<String> {
    anyhow::ensure!(valid_attempt_id(attempt_id), "attemptId is invalid");
    Ok(derived(EXECUTION_KIND, attempt_id, None))
}

pub fn operation_id_for_attempt(attempt_id: &str) -> anyhow::Result<String> {
    anyhow::ensure!(valid_attempt_id(attempt_id), "attemptId is invalid");
    Ok(derived(OPERATION_KIND, attempt_id, None))
}

/// Event ID of one event of the attempt's execution. Each event type occurs
/// at most once per execution, so the type is the discriminator.
pub fn event_id_for_attempt(attempt_id: &str, event_type: &str) -> anyhow::Result<String> {
    anyhow::ensure!(valid_attempt_id(attempt_id), "attemptId is invalid");
    anyhow::ensure!(
        !event_type.is_empty()
            && event_type
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'.' || byte == b'_'),
        "eventType is invalid"
    );
    Ok(derived(EVENT_KIND, attempt_id, Some(event_type)))
}

/// Inverse of [`execution_id_for_attempt`] (exact, case-sensitive).
pub fn attempt_id_from_execution_id(execution_id: &str) -> Option<&str> {
    let attempt_id = execution_id
        .strip_prefix(NIR1_LOCAL_AUDIT_ID_PREFIX)?
        .strip_prefix(EXECUTION_KIND)?
        .strip_prefix(':')?;
    valid_attempt_id(attempt_id).then_some(attempt_id)
}

fn ensure_dedicated_shape(event: &AppendAiAuditEvent) -> anyhow::Result<()> {
    anyhow::ensure!(
        NIR1_LOCAL_AUDIT_PATH_IDS.contains(&event.path_id.as_str()),
        "dedicated NIR-1 local audit append requires a reserved pathId"
    );
    let attempt_id = attempt_id_from_execution_id(&event.execution_id)
        .context("dedicated NIR-1 local audit append requires a derived executionId")?;
    anyhow::ensure!(
        event.operation_id == operation_id_for_attempt(attempt_id)?,
        "dedicated NIR-1 local audit append requires the derived operationId"
    );
    anyhow::ensure!(
        event.event_id == event_id_for_attempt(attempt_id, &event.event_type)?,
        "dedicated NIR-1 local audit append requires the derived eventId"
    );
    anyhow::ensure!(
        event.parent_execution_id.is_none(),
        "dedicated NIR-1 local audit append does not take a parentExecutionId"
    );
    Ok(())
}

/// The only writer of reserved events. Runs inside the caller's open
/// transaction (bounded budget and commit classification belong to the
/// caller) and writes nothing unless every event has the derived shape.
// The bounded start/terminal/sweep writers that call this arrive with the
// audit-writer subtask; until then only the tests use it.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn append_reserved_events_in_transaction(
    conn: &Connection,
    project_id: &str,
    events: &[AppendAiAuditEvent],
) -> anyhow::Result<AiAuditAppendResult> {
    anyhow::ensure!(!events.is_empty(), "reserved audit batch is empty");
    for event in events {
        ensure_dedicated_shape(event)?;
    }
    append_ai_audit_events_in_transaction(conn, Some(project_id), events)
}

#[cfg(test)]
mod tests;
