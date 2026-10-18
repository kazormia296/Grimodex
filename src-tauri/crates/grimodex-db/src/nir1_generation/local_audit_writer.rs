//! Bounded audit writers of the NIR-1 local generation routes (K5/3, S16).
//!
//! The generic `append_ai_audit_events_for_scope` waits on the connection mutex
//! without a deadline and sets a 5 s busy timeout, and it refuses the reserved
//! namespace. The writers here run inside the same participant-owned bounded
//! IMMEDIATE transaction as the other DT-2 writers (mutex 100 ms, busy 100 ms,
//! operation 250 ms) and are the only callers of the dedicated append in
//! `nir1_local_audit`:
//!
//! * [`append_local_audit_start_bounded`] writes `execution.started`,
//!   `request.prepared` and `request.dispatched` in one transaction after the
//!   attempt is claimed and before any connection. A failure is typed and the
//!   caller connects to nothing and sends nothing.
//! * `finish_in_tx` calls [`close_execution_in_tx`] when, and only when, it has
//!   just written the attempt's terminal. The audit terminal is written in that
//!   same transaction, so the two cannot diverge. An attempt without a started
//!   execution gets no audit event. The restart sweep reaches this through
//!   `recover_attempt_in_tx`, so it needs no code of its own.
//!   A success of a started execution without audit data (`Conservative`,
//!   not a recovery) is rejected with the whole transaction instead of being
//!   recorded as `execution.failed`; it must use `finish_attempt_with_audit_bounded`.
//!
//! `request.dispatched` records that the request was handed to the transport
//! thread. It is not evidence that a byte was sent or received.

use grimodex_core::nir1_local_send_policy::{Nir1LocalSendPolicyBasis, Nir1LocalSendPurpose};

use super::*;
use crate::ai_audit::{ai_audit_scope_id, AppendAiAuditEvent};
use crate::nir1_local_audit::{
    append_reserved_events_in_transaction, event_id_for_attempt, execution_id_for_attempt,
    operation_id_for_attempt, NIR1_LOCAL_AUDIT_PATH_IDS, NIR1_LOCAL_REVIEW_PATH_ID,
    NIR1_LOCAL_WRITING_PATH_ID,
};

/// The domain `final_payload_digest` of the Native owner uses for the stored
/// `payload_digest`. The start writer recomputes it from the request value, so
/// the audited request is exactly the body the attempt is bound to.
const FINAL_PAYLOAD_DIGEST_DOMAIN: &str = "nir1-generation-payload@1";

/// What the transport thread handed to the audit, for `request.prepared`.
#[derive(Clone, Debug)]
pub struct Nir1LocalAuditStart {
    /// The canonical payload JSON value (the request body that is sent).
    pub request: Value,
    /// Must equal the attempt's stored `payload_digest`.
    pub payload_digest: String,
    /// The loopback socket the transport connects to, for example
    /// `127.0.0.1:11434`.
    pub socket: String,
    /// The AI usage policy decision the start was authorized under (evidence
    /// only; the audit never authorizes).
    pub policy_basis: Nir1LocalSendPolicyBasis,
    pub timestamp_ms: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1LocalAuditStarted {
    pub execution_id: String,
    /// 3 for a first write; 0 for an identical earlier write.
    pub inserted_count: usize,
}

/// What the transport observed. Handed to the terminal writer, which records
/// it in the same transaction as the attempt terminal.
#[derive(Clone, Debug, Default)]
pub struct Nir1LocalAuditObserved {
    pub text: String,
    pub thinking: String,
    pub usage: Option<Value>,
    pub finish_reason: Option<String>,
    pub http_status: Option<u16>,
}

/// How `finish_in_tx` closes the attempt's started execution.
#[derive(Clone, Copy)]
pub(super) enum AuditClose<'a> {
    /// No audit data: a conservative close (restart sweep, claimed recover, an
    /// owner that has nothing observed).
    Conservative,
    /// The transport-less terminal of DT-2: nothing was sent.
    ZeroSend,
    /// The transport observed a response.
    Observed(&'a Nir1LocalAuditObserved),
}

fn path_id_for_purpose(purpose: &GenerationPurpose) -> &'static str {
    match purpose {
        GenerationPurpose::Writing => NIR1_LOCAL_WRITING_PATH_ID,
        GenerationPurpose::Review => NIR1_LOCAL_REVIEW_PATH_ID,
    }
}

fn policy_purpose(purpose: &GenerationPurpose) -> Nir1LocalSendPurpose {
    match purpose {
        GenerationPurpose::Writing => Nir1LocalSendPurpose::Writing,
        GenerationPurpose::Review => Nir1LocalSendPurpose::Review,
    }
}

fn purpose_name(purpose: &GenerationPurpose) -> &'static str {
    match purpose {
        GenerationPurpose::Writing => "writing",
        GenerationPurpose::Review => "review",
    }
}

fn invalid(error: anyhow::Error) -> Nir1GenerationStoreError {
    Nir1GenerationStoreError::not_committed(Nir1StoreFailure::Invalid, error)
}

fn event(
    path_id: &str,
    attempt_id: &str,
    event_type: &str,
    timestamp: i64,
    payload: Value,
) -> Result<AppendAiAuditEvent> {
    Ok(AppendAiAuditEvent {
        event_id: event_id_for_attempt(attempt_id, event_type)?,
        execution_id: execution_id_for_attempt(attempt_id)?,
        operation_id: operation_id_for_attempt(attempt_id)?,
        parent_execution_id: None,
        path_id: path_id.to_owned(),
        event_type: event_type.to_owned(),
        timestamp,
        payload,
    })
}

fn request_payload_digest(request: &Value) -> Result<String> {
    Ok(canonical_json_digest(&json!({
        "domain": FINAL_PAYLOAD_DIGEST_DOMAIN,
        "payload": request,
    }))?)
}

fn validate_start(
    expected: &Nir1ExpectedAttempt,
    start: &Nir1LocalAuditStart,
) -> std::result::Result<(), Nir1GenerationStoreError> {
    (|| {
        ensure!(
            start.timestamp_ms >= 0,
            "NIR1_LOCAL_AUDIT_START_TIMESTAMP_INVALID"
        );
        ensure!(
            start.request.is_object(),
            "NIR1_LOCAL_AUDIT_START_REQUEST_OBJECT_REQUIRED"
        );
        digest(&start.payload_digest)?;
        ensure!(
            !start.socket.is_empty()
                && start.socket.len() <= MAX_SHORT_TEXT_BYTES
                && start.socket.chars().all(|c| !c.is_control()),
            "NIR1_LOCAL_AUDIT_START_SOCKET_INVALID"
        );
        ensure!(
            start.policy_basis.purpose == policy_purpose(&expected.binding.purpose),
            "NIR1_LOCAL_AUDIT_START_PURPOSE_MISMATCH"
        );
        Ok(())
    })()
    .map_err(invalid)?;
    // The digest handed in, the digest of the request value and the digest the
    // attempt was created with must all be the same.
    if start.payload_digest != expected.payload_digest {
        return Err(Nir1GenerationStoreError::not_committed(
            Nir1StoreFailure::Conflict,
            domain_failure(
                Nir1StoreFailure::Conflict,
                "NIR1_LOCAL_AUDIT_START_PAYLOAD_DIGEST_MISMATCH",
            ),
        ));
    }
    let recomputed = request_payload_digest(&start.request).map_err(invalid)?;
    if recomputed != expected.payload_digest {
        return Err(Nir1GenerationStoreError::not_committed(
            Nir1StoreFailure::Conflict,
            domain_failure(
                Nir1StoreFailure::Conflict,
                "NIR1_LOCAL_AUDIT_START_REQUEST_DIGEST_MISMATCH",
            ),
        ));
    }
    Ok(())
}

fn start_events(
    stored: &StoredAttempt,
    start: &Nir1LocalAuditStart,
) -> Result<[AppendAiAuditEvent; 3]> {
    let binding = &stored.binding;
    let path_id = path_id_for_purpose(&binding.purpose);
    let purpose = purpose_name(&binding.purpose);
    let started = json!({
        "captureState": "complete",
        "attemptId": stored.id,
        "purpose": purpose,
    });
    // Everything except `request.body` sits outside the AI-visible position;
    // no key here is credential-shaped and no credential is ever passed in.
    let prepared = json!({
        "captureState": "complete",
        "credentialsExcluded": true,
        "request": { "body": start.request },
        "attemptId": stored.id,
        "purpose": purpose,
        "payloadDigest": start.payload_digest,
        "provider": binding.provider,
        "socket": start.socket,
        "route": {
            "pathId": path_id,
            "api": binding.api,
            "model": binding.model,
            "endpointIdentity": binding.endpoint_identity,
            "routeRevision": binding.route_revision,
        },
        "policyBasis": serde_json::to_value(start.policy_basis)?,
    });
    let dispatched = json!({
        "captureState": "complete",
        "attemptId": stored.id,
        "purpose": purpose,
        "payloadDigest": start.payload_digest,
        "handoffOnly": true,
    });
    Ok([
        event(
            path_id,
            &stored.id,
            "execution.started",
            start.timestamp_ms,
            started,
        )?,
        event(
            path_id,
            &stored.id,
            "request.prepared",
            start.timestamp_ms,
            prepared,
        )?,
        event(
            path_id,
            &stored.id,
            "request.dispatched",
            start.timestamp_ms,
            dispatched,
        )?,
    ])
}

/// Write the three start events of the exact claimed, unfinished attempt in one
/// bounded transaction. Admission-fenced: the owner's cancel, a participant
/// stop or a false probe interrupts it, and any error means the caller opens no
/// connection. `pre_commit` runs after the events are inserted and before
/// COMMIT, like the claim's. Writing the identical start again inserts nothing.
pub fn append_local_audit_start_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    start: &Nir1LocalAuditStart,
    budget: &Nir1AdmissionSqlBudget,
    pre_commit: &mut dyn FnMut() -> Result<()>,
) -> std::result::Result<Nir1LocalAuditStarted, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    validate_expected_attempt(expected)?;
    validate_start(expected, start)?;
    bounded_write(
        workspace,
        budget.fence(),
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            let stored = read_expected_attempt_in_tx(conn, expected)?;
            if stored.terminal.is_some() {
                return Err(domain_failure(
                    Nir1StoreFailure::TerminalConflict,
                    "NIR1_LOCAL_AUDIT_START_ATTEMPT_TERMINAL",
                ));
            }
            if stored.claimed_at_ms.is_none() {
                return Err(domain_failure(
                    Nir1StoreFailure::ClaimMismatch,
                    "NIR1_LOCAL_AUDIT_START_ATTEMPT_UNCLAIMED",
                ));
            }
            let events = start_events(&stored, start)?;
            let result =
                append_reserved_events_in_transaction(conn, &stored.binding.project_id, &events)?;
            pre_commit()?;
            Ok(Nir1LocalAuditStarted {
                execution_id: execution_id_for_attempt(&stored.id)?,
                inserted_count: result.inserted_count,
            })
        },
    )
    .map_err(|(error, commit)| store_error(error, commit, budget.cancel_requested()))
}

/// The post-transport terminal of the exact claimed attempt, with what the
/// transport observed. The attempt terminal and the audit terminal commit in
/// one transaction. `finish_attempt_bounded` is the same writer without audit
/// data (a conservative audit close).
pub fn finish_attempt_with_audit_bounded(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    observation: &TerminalObservation,
    body: Option<NewMessageBody>,
    now_ms: i64,
    observed: &Nir1LocalAuditObserved,
    budget: &Nir1PinnedSqlBudget,
) -> std::result::Result<StoredTerminal, Nir1GenerationStoreError> {
    finish_attempt_bounded_with(
        workspace,
        expected,
        observation,
        body,
        now_ms,
        AuditClose::Observed(observed),
        budget,
    )
}

fn verify_observed(
    observed: &Nir1LocalAuditObserved,
    observation: &TerminalObservation,
) -> Result<()> {
    let mut observer = OutputObserver::new();
    observer.observe(OutputChannel::Text, observed.text.as_bytes())?;
    observer.observe(OutputChannel::Thinking, observed.thinking.as_bytes())?;
    let seen = observer.finish(Completion::ParseFailure);
    ensure!(
        seen.text_digest == observation.text_digest
            && seen.thinking_digest == observation.thinking_digest,
        "NIR1_LOCAL_AUDIT_OBSERVED_MISMATCH"
    );
    Ok(())
}

pub(super) fn finish_attempt_bounded_with(
    workspace: &ActiveWorkspaceSnapshot,
    expected: &Nir1ExpectedAttempt,
    observation: &TerminalObservation,
    body: Option<NewMessageBody>,
    now_ms: i64,
    close: AuditClose<'_>,
    budget: &Nir1PinnedSqlBudget,
) -> std::result::Result<StoredTerminal, Nir1GenerationStoreError> {
    ensure_no_nested_sql_owner()?;
    validate_expected_attempt(expected)?;
    bounded_write(
        workspace,
        ParticipantSqlFence::Pinned,
        budget.sql_budget(),
        budget.failpoint(),
        |conn| {
            read_expected_attempt_in_tx(conn, expected)?;
            finish_in_tx(
                conn,
                &expected.id,
                observation,
                body.as_ref(),
                now_ms,
                false,
                close,
            )
        },
    )
    .map_err(|(error, commit)| store_error(error, commit, false))
}

#[derive(Default)]
struct ExecutionState {
    path_id: Option<String>,
    terminal: bool,
}

fn read_execution_state(
    conn: &Connection,
    scope_id: &str,
    execution_id: &str,
) -> Result<Option<ExecutionState>> {
    let mut statement = conn.prepare_cached(
        "SELECT path_id,event_type FROM ai_audit_events
          WHERE scope_id=?1 AND execution_id=?2
            AND event_type IN ('execution.started','execution.succeeded','execution.failed',
                               'execution.cancelled','execution.skipped','execution.cache_hit')",
    )?;
    let mut rows = statement.query(params![scope_id, execution_id])?;
    let mut state = ExecutionState::default();
    let mut started = false;
    while let Some(row) = rows.next()? {
        let path_id: String = row.get(0)?;
        let event_type: String = row.get(1)?;
        if event_type == "execution.started" {
            started = true;
            state.path_id = Some(path_id);
        } else {
            state.terminal = true;
        }
    }
    Ok(started.then_some(state))
}

fn name_of<T: Serialize>(value: &T) -> Result<Value> {
    Ok(serde_json::to_value(value)?)
}

/// Close the attempt's started execution, in the transaction that has just
/// written the attempt terminal. Nothing is written when the attempt has no
/// started execution or the execution already ended.
pub(super) fn close_execution_in_tx(
    conn: &Connection,
    project_id: &str,
    attempt_id: &str,
    observation: &TerminalObservation,
    terminal: &StoredTerminal,
    close: AuditClose<'_>,
    recovery: bool,
) -> Result<()> {
    let Ok(execution_id) = execution_id_for_attempt(attempt_id) else {
        // Not a derivable ID: no execution can exist for it.
        return Ok(());
    };
    let scope_id = ai_audit_scope_id(Some(project_id))?;
    let Some(state) = read_execution_state(conn, &scope_id, &execution_id)? else {
        return Ok(());
    };
    if state.terminal {
        return Ok(());
    }
    let path_id = state
        .path_id
        .as_deref()
        .and_then(|path| {
            NIR1_LOCAL_AUDIT_PATH_IDS
                .iter()
                .find(|known| **known == path)
        })
        .context("NIR1_LOCAL_AUDIT_EXECUTION_PATH_INVALID")?;
    let purpose = if *path_id == NIR1_LOCAL_REVIEW_PATH_ID {
        "review"
    } else {
        "writing"
    };
    let timestamp = terminal.completed_at_ms;
    let terminal_status = observation.terminal_status;
    // A success of a started execution can only be recorded with the observed
    // response (`response.completed`). The data-less writer used to turn it
    // into `execution.failed (audit-data-missing)` while the attempt stayed
    // succeeded; it now rejects the whole transaction, so the attempt terminal
    // is not written either and the owner's failure path (`recover`) closes
    // the execution conservatively. Not reached for an attempt without a
    // started execution, for the restart sweep / claimed recover
    // (`recovery`), or for a zero-send terminal.
    if !recovery
        && matches!(close, AuditClose::Conservative)
        && terminal_status == TerminalStatus::Succeeded
    {
        return Err(domain_failure(
            Nir1StoreFailure::Invalid,
            "NIR1_LOCAL_AUDIT_SUCCESS_REQUIRES_AUDIT_DATA",
        ));
    }
    let mut events = Vec::with_capacity(3);
    let mut common = json!({
        "attemptId": attempt_id,
        "purpose": purpose,
        "terminalStatus": name_of(&terminal_status)?,
        "parseStatus": name_of(&observation.parse_status)?,
        "classification": name_of(&terminal.failure_classification)?,
        "retry": name_of(&terminal.retry_classification)?,
    });
    let terminal_type;
    match (close, recovery) {
        (AuditClose::Observed(observed), false) => {
            verify_observed(observed, observation)?;
            if terminal_status == TerminalStatus::Succeeded {
                let mut response = json!({
                    "text": observed.text,
                    "thinking": observed.thinking,
                });
                if let Some(usage) = &observed.usage {
                    response["usage"] = usage.clone();
                }
                if let Some(reason) = &observed.finish_reason {
                    response["finishReason"] = Value::String(reason.clone());
                }
                let mut completed = json!({"captureState": "complete", "response": response});
                if let Some(status) = observed.http_status {
                    completed["httpStatus"] = Value::from(status);
                }
                events.push(event(
                    path_id,
                    attempt_id,
                    "response.completed",
                    timestamp,
                    completed,
                )?);
                terminal_type = "execution.succeeded";
            } else {
                if !observed.text.is_empty() || !observed.thinking.is_empty() {
                    events.push(event(
                        path_id,
                        attempt_id,
                        "response.partial",
                        timestamp,
                        json!({
                            "captureState": "partial",
                            "response": {
                                "text": observed.text,
                                "thinking": observed.thinking,
                            },
                        }),
                    )?);
                }
                if let Some(status) = observed.http_status {
                    common["httpStatus"] = Value::from(status);
                }
                common["remoteOutcome"] = Value::from("observed");
                terminal_type = if terminal_status == TerminalStatus::Cancelled {
                    "execution.cancelled"
                } else {
                    "execution.failed"
                };
            }
            common["captureState"] = Value::from("complete");
        }
        (AuditClose::ZeroSend, false) => {
            common["captureState"] = Value::from("complete");
            common["remoteOutcome"] = Value::from("not-sent");
            common["responseObserved"] = Value::Bool(false);
            terminal_type = if terminal_status == TerminalStatus::Cancelled {
                "execution.cancelled"
            } else {
                "execution.failed"
            };
        }
        // Conservative: only the classification and that the other side's
        // processing is unknown. No response content (none was observed).
        _ => {
            common["captureState"] = Value::from("partial");
            common["remoteOutcome"] = Value::from("unknown");
            common["responseObserved"] = Value::Bool(false);
            common["conservative"] = Value::Bool(true);
            if recovery {
                common["source"] = Value::from("recovery");
            }
            if terminal_status == TerminalStatus::Succeeded {
                // A success terminal without audit data cannot be recorded as
                // a success (no response.completed): it closes as a failed
                // audit record that names the attempt's own outcome.
                common["classification"] = Value::from("audit-data-missing");
                common["attemptTerminalStatus"] = Value::from("succeeded");
            }
            terminal_type = if terminal_status == TerminalStatus::Cancelled && !recovery {
                "execution.cancelled"
            } else {
                "execution.failed"
            };
        }
    }
    if terminal_type == "execution.succeeded" {
        common["captureState"] = Value::from("complete");
    }
    events.push(event(
        path_id,
        attempt_id,
        terminal_type,
        timestamp,
        common,
    )?);
    append_reserved_events_in_transaction(conn, project_id, &events)?;
    Ok(())
}
