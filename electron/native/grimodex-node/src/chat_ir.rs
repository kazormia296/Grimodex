//! chat IR S1-A: the Native one-shot that hands an agent the approved
//! Chronicle IR (summary and quote) of earlier Scenes (DR-CHATIR-S1-13 to 27).
//!
//! The command stays closed: the Native gate (`PrePublicationEntry::ChatAgentIr`)
//! is checked before the request is even parsed, nothing in the product opens
//! it, and Main and the renderer are closed as well. What this module makes
//! sure of, for the day it is opened, is that one call ends: a deadline for
//! every step, at most [`ChatIrConfig::max_in_flight`] calls in flight, no wait
//! on a busy connection, no model load, and an answer that is always one of a
//! closed set of statuses.

mod basis;
mod flow;
mod item;
mod ledger;
mod native;
mod permit;
mod request;
mod status;
mod tail;

#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use serde_json::Value;

use crate::main_grant::PrePublicationEntry;
use crate::state::AppState;

use flow::{execute, ChatIrResult};
use ledger::Ledger;
use native::NativeBackend;
use permit::PermitPool;
use request::{query_is_valid, Request};
use status::ChatIrStatus;

/// The closed code of a call while the Native gate is closed. Not a status: it
/// is an error, and nothing was audited, embedded or counted.
pub(crate) const GATE_CLOSED: &str = "CHAT_IR_GATE_CLOSED";
/// A request that is not the exact shape (an unknown or missing key, a wrong
/// type).
pub(crate) const INVALID_REQUEST: &str = "CHAT_IR_INVALID_REQUEST";

/// The initial values (DR-CHATIR-S1-13 to 15, 23). Lowering one is a technical
/// decision; raising the deadline beyond "deadline plus one inference plus one
/// append" or the in-flight limit above 2 is not (design Q-b).
#[derive(Clone, Copy, Debug)]
pub(crate) struct ChatIrConfig {
    /// One deadline for the whole call, counted from its acceptance.
    pub(crate) deadline: Duration,
    /// How long the first read may wait for the connection.
    pub(crate) connection_probe: Duration,
    pub(crate) max_in_flight: usize,
    pub(crate) ledger_capacity: usize,
    /// The tail after the response (the user's answer of 2026-11-17).
    pub(crate) tail_budget: Duration,
    pub(crate) tail_slice: Duration,
    pub(crate) close_flush: Duration,
}

impl Default for ChatIrConfig {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(10),
            connection_probe: Duration::from_secs(1),
            max_in_flight: 2,
            ledger_capacity: 4096,
            tail_budget: grimodex_semantic::runtime::TERMINAL_BACKFILL_BUDGET,
            tail_slice: Duration::from_millis(250),
            close_flush: Duration::from_secs(1),
        }
    }
}

/// Process-local. Nothing here is persisted.
pub(crate) struct ChatIrState {
    pub(crate) config: ChatIrConfig,
    permits: Arc<PermitPool>,
    ledger: Mutex<Ledger>,
}

impl ChatIrState {
    pub(crate) fn new(config: ChatIrConfig) -> Self {
        Self {
            permits: PermitPool::new(config.max_in_flight),
            ledger: Mutex::new(Ledger::new(config.ledger_capacity)),
            config,
        }
    }
}

impl Default for ChatIrState {
    fn default() -> Self {
        Self::new(ChatIrConfig::default())
    }
}

/// `chat_agent_ir_select`. The order of the refusals is the design's: the gate,
/// the shape of the request, the query, the permit, the participant and the
/// pinned workspace. A refusal before the permit audits nothing and runs no
/// inference.
pub(crate) async fn select(state: Arc<AppState>, payload: Value) -> Result<String> {
    if !state
        .main_grant
        .gate
        .is_open(PrePublicationEntry::ChatAgentIr)
    {
        return Err(anyhow!(GATE_CLOSED));
    }
    let request: Request = serde_json::from_value(payload).map_err(|_| anyhow!(INVALID_REQUEST))?;
    let accepted_at = Instant::now();
    if !query_is_valid(&request.query) {
        return Ok(answer(ChatIrStatus::QueryInvalid));
    }
    // Taken here, without waiting, and moved into the task: a task still queued
    // behind a saturated blocking pool is counted too.
    let Some(permit) = state.chat_ir.permits.try_acquire() else {
        return Ok(answer(ChatIrStatus::Busy));
    };
    let Ok(participant) = state.ws.lifecycle_core().begin_workspace_participant() else {
        return Ok(answer(ChatIrStatus::WorkspaceUnavailable));
    };
    let Ok(pinned) = crate::pin_scoped_semantic_request(&state, &request.expected_workspace_path)
    else {
        return Ok(answer(ChatIrStatus::WorkspaceChanged));
    };
    let config = state.chat_ir.config;
    let backend = NativeBackend::new(Arc::clone(&state), pinned, participant);
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // The join handle is not awaited: the task outlives the answer by the tail.
    drop(tokio::task::spawn_blocking(move || {
        execute(
            backend,
            permit,
            config,
            &state.chat_ir.ledger,
            request,
            accepted_at,
            sender,
        );
        drop(state);
    }));
    Ok(wire_of_answer(receiver).await)
}

/// What the call answers once its task is running: the task's result, or, when
/// the task ended without answering (it panicked; what it held was released as
/// it unwound, and the sender was dropped), the closed `internal`. `select`
/// and the tests both go through this one function.
async fn wire_of_answer(receiver: tokio::sync::oneshot::Receiver<ChatIrResult>) -> String {
    match receiver.await {
        Ok(result) => result.to_wire().to_string(),
        Err(_) => answer(ChatIrStatus::Internal),
    }
}

fn answer(status: ChatIrStatus) -> String {
    ChatIrResult::status_only(status).to_wire().to_string()
}
