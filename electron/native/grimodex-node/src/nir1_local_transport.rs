//! NIR-1 local generation transport (K5/3, DT-5b). No N-API entry, IPC route or
//! product caller exists: DD-1 calls [`start_local_generation`] with the
//! [`Nir1TransportOwner`] a `claim_for_transport` returned, and takes the
//! output from the returned [`Nir1LocalRun`].
//!
//! One attempt, one connection, two threads (DR-DT5-3):
//!
//! - the supervisor thread owns the owner and is the only thread that touches
//!   the database (audit start, policy read, send decisions, terminal write,
//!   gate quarantine, owner drop). It holds no DB mutex, no profile or
//!   lifecycle lock and no DT-1 lease while it waits for HTTP;
//! - the I/O thread owns the `TcpStream`, the response parser and the sending
//!   side of a bounded channel. It has no owner, no database and no lease.
//!
//! Order, each step bounded (K1b numbers in [`Nir1LocalTransportConfig`]):
//! binding check (target identity, payload digest, purpose, `stream: true`),
//! audit start (three events durable before any socket), policy re-read outside
//! every lock, send decision 1, one `connect_timeout` to the `SocketAddr` of
//! the target and a check that the peer is exactly that address, send decision
//! 2, then `GO`. The I/O thread writes its first byte only after `GO`: without
//! `GO` nothing was sent, with it the send is treated as having happened.
//! The supervisor then feeds the parsed text/thinking to an `OutputObserver`,
//! watches cancel, the entry witness and the permit every `cancel_poll`, and
//! writes exactly one terminal. A cancel shuts the socket down and joins the
//! I/O thread for at most `join_limit`; when the join overruns the supervisor
//! quarantines the gate, writes the terminal once, detaches the thread and
//! throws every later observation away.
//!
//! Out of scope on purpose (prevented by nothing here and claimed by nothing):
//! whatever listens on the configured loopback port, and what it does with the
//! bytes it received.

#![cfg_attr(not(test), allow(dead_code))]

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use grimodex_core::canonical_json_string;
use grimodex_core::narrative_nir1_receipt::{
    Completion, OutputChannel, OutputObservationError, OutputObserver, TerminalStatus,
};
use grimodex_core::nir1_local_io::{join_bounded, shutdown_both, JoinOutcome, IO_SLICE};
use grimodex_core::nir1_local_send_policy::{Nir1LocalSendPolicyBasis, Nir1LocalSendPurpose};
use grimodex_core::nir1_local_wire::{
    build_request_head, Limits, Progress, ResponseParser, WireEvent, WireFailure,
};
use grimodex_db::nir1_generation::{
    GenerationPurpose, NewMessageBody, Nir1LocalAuditObserved, Nir1LocalAuditStart,
    Nir1StoreFailure, StoredTerminal,
};
use serde_json::Value;

use crate::nir1_generation::{final_payload_digest, now_ms};
use crate::nir1_generation_owner::{
    Nir1FinishFailure, Nir1OwnerCancel, Nir1SendDecision, Nir1SendRefusal, Nir1Settlement,
    Nir1TransportOwner,
};
use crate::nir1_prepared_request::LoopbackChatEndpoint;

/// Durations and queue sizes of one attempt (DR-DT5-9). The product uses
/// [`Self::DEFAULT`]; tests inject small values.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Nir1LocalTransportConfig {
    pub(crate) wire: Limits,
    /// `TcpStream::connect_timeout` to the single `SocketAddr`.
    pub(crate) connect_timeout: Duration,
    /// The request head and body, from `GO` to the last byte written.
    pub(crate) request_write_timeout: Duration,
    /// From the last request byte to the first response byte.
    pub(crate) first_byte_timeout: Duration,
    /// Between two decoded stream events (the head counts as one). A comment
    /// line does not extend it.
    pub(crate) event_gap_timeout: Duration,
    /// From `GO` to the end of the body.
    pub(crate) total_timeout: Duration,
    /// From `[DONE]` to the end of the body.
    pub(crate) done_body_end_timeout: Duration,
    /// How often the supervisor looks at cancel, the witness and the permit.
    pub(crate) cancel_poll: Duration,
    /// From the shutdown (or the end message) to the end of the I/O thread.
    pub(crate) join_limit: Duration,
    /// Messages in the bounded channel from the I/O thread.
    pub(crate) channel_messages: usize,
    /// Text and thinking bytes in flight in that channel.
    pub(crate) channel_bytes: usize,
}

impl Nir1LocalTransportConfig {
    /// Final values of DT-5 (DR-DT5-21, DR-DT5-26; no real server could be
    /// measured, so none may be loosened without a new confirmation).
    /// `connect_timeout` is shorter than `join_limit`: a cancel seen while
    /// connecting waits for the connect to end, and then the join.
    pub(crate) const DEFAULT: Self = Self {
        wire: Limits::DEFAULT,
        connect_timeout: Duration::from_secs(1),
        request_write_timeout: Duration::from_secs(10),
        first_byte_timeout: Duration::from_secs(300),
        event_gap_timeout: Duration::from_secs(60),
        total_timeout: Duration::from_secs(600),
        done_body_end_timeout: Duration::from_secs(2),
        cancel_poll: Duration::from_millis(50),
        join_limit: Duration::from_secs(2),
        channel_messages: 256,
        channel_bytes: 1024 * 1024,
    };

    fn is_valid(&self) -> bool {
        let durations = [
            self.connect_timeout,
            self.request_write_timeout,
            self.first_byte_timeout,
            self.event_gap_timeout,
            self.total_timeout,
            self.done_body_end_timeout,
            self.cancel_poll,
            self.join_limit,
        ];
        durations.iter().all(|duration| !duration.is_zero())
            && self.connect_timeout < self.join_limit
            && self.channel_messages > 0
            && self.channel_bytes > 0
    }
}

impl Default for Nir1LocalTransportConfig {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// What DD-1 hands to [`start_local_generation`]. It has no renderer value:
/// the target is the route's [`LoopbackChatEndpoint`], the policy basis is
/// what the check before the attempt saw.
pub(crate) struct Nir1LocalGenerationInput {
    pub(crate) target: LoopbackChatEndpoint,
    pub(crate) purpose: Nir1LocalSendPurpose,
    pub(crate) policy_basis: Nir1LocalSendPolicyBasis,
    /// The ID of the assistant message a success stores.
    pub(crate) message_id: String,
    pub(crate) config: Nir1LocalTransportConfig,
    #[cfg(test)]
    pub(crate) hooks: Option<Arc<TransportTestHooks>>,
}

impl Nir1LocalGenerationInput {
    pub(crate) fn new(
        target: LoopbackChatEndpoint,
        purpose: Nir1LocalSendPurpose,
        policy_basis: Nir1LocalSendPolicyBasis,
        message_id: String,
    ) -> Self {
        Self {
            target,
            purpose,
            policy_basis,
            message_id,
            config: Nir1LocalTransportConfig::DEFAULT,
            #[cfg(test)]
            hooks: None,
        }
    }
}

// ---------------------------------------------------------------------------
// The run handle DD-1 reads from.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Nir1LocalRunState {
    /// Output so far is unconfirmed: no terminal is durable yet.
    Running,
    /// The success terminal (body, version, receipt, audit) is durable.
    Succeeded,
    Failed,
    Cancelled,
}

impl Nir1LocalRunState {
    pub(crate) fn is_final(self) -> bool {
        self != Self::Running
    }
}

/// What a `take_delta` returns: new text and thinking (separate channels) and
/// the state read in the same step.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct Nir1LocalDelta {
    pub(crate) text: String,
    pub(crate) thinking: String,
    pub(crate) state: Nir1LocalRunState,
}

#[derive(Debug)]
pub(crate) enum Nir1LocalRunEnd {
    /// This run wrote the terminal (any status).
    Terminal(Box<StoredTerminal>),
    /// The send never began and a zero-send terminal settled the attempt.
    Settled(Nir1Settlement),
    /// The terminal write failed. `durable` is the terminal the conservative
    /// recovery made or kept, when there is one.
    FinishFailed {
        failure: Nir1StoreFailure,
        durable: Option<Box<StoredTerminal>>,
    },
}

#[derive(Debug)]
pub(crate) struct Nir1LocalRunOutcome {
    pub(crate) state: Nir1LocalRunState,
    pub(crate) end: Nir1LocalRunEnd,
    /// A fixed word for why the run ended the way it did (logs and tests).
    pub(crate) reason: &'static str,
    /// The I/O thread did not end in time and was detached; the gate entry
    /// was quarantined.
    pub(crate) io_thread_detached: bool,
}

struct RunInner {
    text: String,
    thinking: String,
    state: Nir1LocalRunState,
    outcome: Option<Arc<Nir1LocalRunOutcome>>,
}

struct RunShared {
    inner: Mutex<RunInner>,
    changed: Condvar,
    cancel: Nir1OwnerCancel,
}

impl RunShared {
    fn new(cancel: Nir1OwnerCancel) -> Self {
        Self {
            inner: Mutex::new(RunInner {
                text: String::new(),
                thinking: String::new(),
                state: Nir1LocalRunState::Running,
                outcome: None,
            }),
            changed: Condvar::new(),
            cancel,
        }
    }

    fn lock(&self) -> MutexGuard<'_, RunInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn push(&self, text: &str, thinking: &str) {
        if text.is_empty() && thinking.is_empty() {
            return;
        }
        let mut inner = self.lock();
        inner.text.push_str(text);
        inner.thinking.push_str(thinking);
    }

    /// Set the final state once. The first writer wins.
    fn finish(
        &self,
        state: Nir1LocalRunState,
        end: Nir1LocalRunEnd,
        reason: &'static str,
        io_thread_detached: bool,
    ) {
        let mut inner = self.lock();
        if inner.outcome.is_some() {
            return;
        }
        inner.state = state;
        inner.outcome = Some(Arc::new(Nir1LocalRunOutcome {
            state,
            end,
            reason,
            io_thread_detached,
        }));
        drop(inner);
        self.changed.notify_all();
    }
}

/// Marks the run failed when the supervisor thread ends without a final state
/// (a panic). The owner's own Drop then records `InterruptedUnknown`.
struct RunGuard(Arc<RunShared>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        let mut inner = self.0.lock();
        if inner.outcome.is_none() {
            inner.state = Nir1LocalRunState::Failed;
            inner.outcome = Some(Arc::new(Nir1LocalRunOutcome {
                state: Nir1LocalRunState::Failed,
                end: Nir1LocalRunEnd::FinishFailed {
                    failure: Nir1StoreFailure::Invalid,
                    durable: None,
                },
                reason: "supervisor-ended",
                io_thread_detached: false,
            }));
            drop(inner);
            self.0.changed.notify_all();
        }
    }
}

/// The receiving end of one local generation. Output leaves the Native side
/// only by [`Self::take_delta`] on this value: nothing is broadcast, and
/// nothing is final until the state says so.
pub(crate) struct Nir1LocalRun {
    shared: Arc<RunShared>,
}

impl Nir1LocalRun {
    pub(crate) fn cancel_handle(&self) -> Nir1OwnerCancel {
        self.shared.cancel.clone()
    }

    pub(crate) fn cancel(&self) {
        self.shared.cancel.cancel();
    }

    /// Take at most `limit` bytes of new text and of new thinking (each cut at
    /// a character boundary; at least one character when `limit` is smaller
    /// than the next one and `limit > 0`) with the state read together.
    pub(crate) fn take_delta(&self, limit: usize) -> Nir1LocalDelta {
        let mut inner = self.shared.lock();
        let text = take_prefix(&mut inner.text, limit);
        let thinking = take_prefix(&mut inner.thinking, limit);
        Nir1LocalDelta {
            text,
            thinking,
            state: inner.state,
        }
    }

    pub(crate) fn state(&self) -> Nir1LocalRunState {
        self.shared.lock().state
    }

    /// The final outcome once the run is over.
    pub(crate) fn outcome(&self) -> Option<Arc<Nir1LocalRunOutcome>> {
        self.shared.lock().outcome.clone()
    }

    /// Wait until the run is final or `timeout` passes.
    pub(crate) fn wait_final(&self, timeout: Duration) -> Option<Arc<Nir1LocalRunOutcome>> {
        let deadline = Instant::now() + timeout;
        let mut inner = self.shared.lock();
        loop {
            if let Some(outcome) = &inner.outcome {
                return Some(Arc::clone(outcome));
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            inner = self
                .shared
                .changed
                .wait_timeout(inner, deadline - now)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }
}

fn take_prefix(buffer: &mut String, limit: usize) -> String {
    if buffer.is_empty() || limit == 0 {
        return String::new();
    }
    let mut end = limit.min(buffer.len());
    while end > 0 && !buffer.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        end = buffer.chars().next().map_or(0, char::len_utf8);
    }
    buffer.drain(..end).collect()
}

// ---------------------------------------------------------------------------
// The entry.
// ---------------------------------------------------------------------------

/// Start one local generation for a claimed attempt. The owner is consumed:
/// the attempt is sent at most once, and exactly one terminal is written (a
/// zero-send terminal when nothing was sent). Returns at once; the work runs
/// on the supervisor thread.
pub(crate) fn start_local_generation(
    owner: Nir1TransportOwner,
    input: Nir1LocalGenerationInput,
) -> Nir1LocalRun {
    let shared = Arc::new(RunShared::new(owner.cancel_handle()));
    // If the thread cannot be spawned the owner is still here to settle.
    let cell = Arc::new(Mutex::new(Some(owner)));
    let moved = Arc::clone(&cell);
    let supervised = Arc::clone(&shared);
    let spawned = thread::Builder::new()
        .name("nir1-local-supervisor".into())
        .spawn(move || {
            let owner = moved.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some(owner) = owner {
                supervise(owner, input, supervised);
            }
        });
    if spawned.is_err() {
        let owner = cell.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(owner) = owner {
            settle_without_send(owner, &shared, "supervisor-spawn-failed");
        }
    }
    Nir1LocalRun { shared }
}

fn state_of_terminal(terminal: &StoredTerminal) -> Nir1LocalRunState {
    match terminal
        .observation
        .get("terminalStatus")
        .and_then(Value::as_str)
    {
        Some("succeeded") => Nir1LocalRunState::Succeeded,
        Some("cancelled") => Nir1LocalRunState::Cancelled,
        _ => Nir1LocalRunState::Failed,
    }
}

fn settle_without_send(owner: Nir1TransportOwner, run: &RunShared, reason: &'static str) {
    let settlement = owner.settle_without_send();
    let state = match &settlement {
        Nir1Settlement::ZeroSend(terminal) => state_of_terminal(terminal),
        _ => Nir1LocalRunState::Failed,
    };
    run.finish(state, Nir1LocalRunEnd::Settled(settlement), reason, false);
}

fn purpose_matches(bound: &GenerationPurpose, purpose: Nir1LocalSendPurpose) -> bool {
    matches!(
        (bound, purpose),
        (GenerationPurpose::Writing, Nir1LocalSendPurpose::Writing)
            | (GenerationPurpose::Review, Nir1LocalSendPurpose::Review)
    )
}

struct BoundSend {
    request: Value,
    payload_digest: String,
    body: Vec<u8>,
}

/// The target, payload and purpose the attempt bound must be the ones this
/// call would send to and send. Anything else sends nothing.
fn verify_binding(
    owner: &Nir1TransportOwner,
    input: &Nir1LocalGenerationInput,
) -> Result<BoundSend, &'static str> {
    if !input.config.is_valid() {
        return Err("config-invalid");
    }
    let identity = input
        .target
        .identity_digest()
        .map_err(|_| "target-identity-unavailable")?;
    if identity != owner.bound_endpoint_identity() {
        return Err("target-identity-mismatch");
    }
    if !purpose_matches(owner.bound_purpose(), input.purpose)
        || input.policy_basis.purpose != input.purpose
    {
        return Err("purpose-mismatch");
    }
    let payload = owner.canonical_payload();
    let request: Value = serde_json::from_str(payload).map_err(|_| "payload-not-json")?;
    match canonical_json_string(&request) {
        Ok(canonical) if canonical == payload => {}
        _ => return Err("payload-not-canonical"),
    }
    let digest = final_payload_digest(&request).map_err(|_| "payload-digest-unavailable")?;
    if digest != owner.bound_payload_digest() {
        return Err("payload-digest-mismatch");
    }
    if request.get("stream") != Some(&Value::Bool(true)) {
        return Err("payload-not-streaming");
    }
    Ok(BoundSend {
        request,
        payload_digest: digest,
        body: payload.as_bytes().to_vec(),
    })
}

fn refusal_reason(refusal: Nir1SendRefusal) -> &'static str {
    match refusal {
        Nir1SendRefusal::Cancelled => "send-refused-cancelled",
        Nir1SendRefusal::EntryLost => "send-refused-entry-lost",
        Nir1SendRefusal::PermitClosed => "send-refused-permit-closed",
        Nir1SendRefusal::PolicyDenied => "send-refused-policy",
    }
}

// ---------------------------------------------------------------------------
// The I/O thread.
// ---------------------------------------------------------------------------

enum IoMsg {
    /// A clone of the connected socket, for the supervisor to shut down.
    Connected(TcpStream),
    Events {
        events: Vec<WireEvent>,
        size: usize,
    },
    End {
        end: IoEnd,
        head_ok: bool,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IoEnd {
    // Before `GO`: nothing was written.
    ConnectFailed,
    PeerMismatch,
    Aborted,
    // After `GO`.
    Parsed,
    Wire(WireFailure),
    WriteFailed,
    WriteTimeout,
    ReadFailed,
    FirstByteTimeout,
    EventGapTimeout,
    TotalTimeout,
    DoneBodyEndTimeout,
}

impl IoEnd {
    fn reason(self) -> &'static str {
        match self {
            Self::ConnectFailed => "connect-failed",
            Self::PeerMismatch => "peer-mismatch",
            Self::Aborted => "io-aborted",
            Self::Parsed => "parsed",
            Self::Wire(_) => "wire-failure",
            Self::WriteFailed => "write-failed",
            Self::WriteTimeout => "write-timeout",
            Self::ReadFailed => "read-failed",
            Self::FirstByteTimeout => "first-byte-timeout",
            Self::EventGapTimeout => "event-gap-timeout",
            Self::TotalTimeout => "total-timeout",
            Self::DoneBodyEndTimeout => "done-body-end-timeout",
        }
    }

    /// The observer completion once the first byte may have gone out.
    fn completion(self) -> Completion {
        match self {
            Self::Parsed => Completion::Parsed,
            Self::Wire(failure) => failure.completion(),
            _ => Completion::UnexpectedEof,
        }
    }
}

struct IoPlan {
    addr: SocketAddr,
    head: Vec<u8>,
    body: Vec<u8>,
    config: Nir1LocalTransportConfig,
    tx: SyncSender<IoMsg>,
    go_rx: Receiver<()>,
    inflight: Arc<AtomicUsize>,
    abort: Arc<AtomicBool>,
    #[cfg(test)]
    hooks: Option<Arc<TransportTestHooks>>,
}

impl IoPlan {
    fn aborted(&self) -> bool {
        self.abort.load(Ordering::Acquire)
    }

    /// Blocking send that gives up when the supervisor stopped listening.
    fn send_msg(&self, mut message: IoMsg) -> Result<(), ()> {
        loop {
            if self.aborted() {
                return Err(());
            }
            match self.tx.try_send(message) {
                Ok(()) => return Ok(()),
                Err(TrySendError::Full(back)) => {
                    message = back;
                    thread::sleep(Duration::from_millis(1));
                }
                Err(TrySendError::Disconnected(_)) => return Err(()),
            }
        }
    }

    fn send_events(&self, events: Vec<WireEvent>) -> Result<(), ()> {
        let size: usize = events
            .iter()
            .map(|event| {
                let bytes = match event {
                    WireEvent::Thinking(text) | WireEvent::Text(text) => text.len(),
                    WireEvent::Terminal(_) | WireEvent::Done => 0,
                };
                bytes + 16
            })
            .sum();
        loop {
            if self.aborted() {
                return Err(());
            }
            let current = self.inflight.load(Ordering::Acquire);
            if current == 0 || current.saturating_add(size) <= self.config.channel_bytes {
                break;
            }
            thread::sleep(Duration::from_millis(1));
        }
        self.inflight.fetch_add(size, Ordering::AcqRel);
        if self.send_msg(IoMsg::Events { events, size }).is_err() {
            self.inflight.fetch_sub(size, Ordering::AcqRel);
            return Err(());
        }
        Ok(())
    }

    fn peer_matches(&self, stream: &TcpStream) -> bool {
        let Ok(peer) = stream.peer_addr() else {
            return false;
        };
        #[cfg(test)]
        let peer = self
            .hooks
            .as_ref()
            .and_then(|hooks| {
                *hooks
                    .peer_override
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
            })
            .unwrap_or(peer);
        peer == self.addr && peer.ip().is_loopback()
    }
}

fn io_main(plan: IoPlan) {
    let mut stream_slot: Option<TcpStream> = None;
    let mut head_ok = false;
    let end = io_run(&plan, &mut stream_slot, &mut head_ok);
    #[cfg(test)]
    if let Some(hooks) = &plan.hooks {
        hooks.wedge_before_end();
    }
    if !plan.aborted() {
        let _ = plan.send_msg(IoMsg::End { end, head_ok });
    }
    drop(stream_slot);
    #[cfg(test)]
    if let Some(hooks) = &plan.hooks {
        hooks.io_exited.store(true, Ordering::Release);
    }
}

fn write_all_until(
    stream: &mut TcpStream,
    mut buffer: &[u8],
    deadline: Instant,
    abort: &AtomicBool,
) -> Result<(), IoEnd> {
    while !buffer.is_empty() {
        if abort.load(Ordering::Acquire) {
            return Err(IoEnd::Aborted);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(IoEnd::WriteTimeout);
        }
        stream
            .set_write_timeout(Some(
                (deadline - now).min(IO_SLICE).max(Duration::from_millis(1)),
            ))
            .map_err(|_| IoEnd::WriteFailed)?;
        match stream.write(buffer) {
            Ok(0) => return Err(IoEnd::WriteFailed),
            Ok(written) => buffer = &buffer[written..],
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return Err(IoEnd::WriteFailed),
        }
    }
    Ok(())
}

fn io_run(plan: &IoPlan, slot: &mut Option<TcpStream>, head_ok: &mut bool) -> IoEnd {
    let config = &plan.config;
    // One connection, to the one `SocketAddr` of the target. No name is
    // resolved and no other address is tried.
    let Ok(connected) = TcpStream::connect_timeout(&plan.addr, config.connect_timeout) else {
        return IoEnd::ConnectFailed;
    };
    let stream = slot.insert(connected);
    if !plan.peer_matches(stream) {
        return IoEnd::PeerMismatch;
    }
    let _ = stream.set_nodelay(true);
    let Ok(clone) = stream.try_clone() else {
        return IoEnd::ConnectFailed;
    };
    if plan.send_msg(IoMsg::Connected(clone)).is_err() {
        return IoEnd::Aborted;
    }
    // Not one byte before the supervisor's `GO`.
    if plan.go_rx.recv_timeout(config.join_limit).is_err() || plan.aborted() {
        return IoEnd::Aborted;
    }

    let started = Instant::now();
    let total_deadline = started + config.total_timeout;
    let write_deadline = (started + config.request_write_timeout).min(total_deadline);
    for part in [&plan.head, &plan.body] {
        if let Err(end) = write_all_until(stream, part, write_deadline, &plan.abort) {
            return end;
        }
    }
    let write_end = Instant::now();

    let mut parser = ResponseParser::new(config.wire);
    let mut buffer = vec![0u8; 16 * 1024];
    let mut events: Vec<WireEvent> = Vec::new();
    let mut got_first_byte = false;
    let mut head_seen = false;
    let mut gap_start = write_end;
    let mut done_at: Option<Instant> = None;
    loop {
        if plan.aborted() {
            return IoEnd::Aborted;
        }
        let now = Instant::now();
        let (mut deadline, mut timeout) = match done_at {
            Some(at) => (at + config.done_body_end_timeout, IoEnd::DoneBodyEndTimeout),
            None if !got_first_byte => (
                write_end + config.first_byte_timeout,
                IoEnd::FirstByteTimeout,
            ),
            None => (gap_start + config.event_gap_timeout, IoEnd::EventGapTimeout),
        };
        if total_deadline < deadline {
            deadline = total_deadline;
            timeout = IoEnd::TotalTimeout;
        }
        if now >= deadline {
            return timeout;
        }
        if stream
            .set_read_timeout(Some(
                (deadline - now).min(IO_SLICE).max(Duration::from_millis(1)),
            ))
            .is_err()
        {
            return IoEnd::ReadFailed;
        }
        match stream.read(&mut buffer) {
            Ok(0) => {
                let result = parser.finish_eof();
                *head_ok = parser.head().is_some();
                return match result {
                    Ok(()) => IoEnd::Parsed,
                    Err(failure) => IoEnd::Wire(failure),
                };
            }
            Ok(count) => {
                got_first_byte = true;
                events.clear();
                let result = parser.push(&buffer[..count], &mut events);
                *head_ok = parser.head().is_some();
                let now = Instant::now();
                if parser.head().is_some() && !head_seen {
                    head_seen = true;
                    gap_start = now;
                }
                if !events.is_empty() {
                    gap_start = now;
                    if done_at.is_none() && events.contains(&WireEvent::Done) {
                        done_at = Some(now);
                    }
                    if plan.send_events(std::mem::take(&mut events)).is_err() {
                        return IoEnd::Aborted;
                    }
                }
                match result {
                    Ok(Progress::Finished) => return IoEnd::Parsed,
                    Ok(Progress::NeedMore) => {}
                    Err(failure) => return IoEnd::Wire(failure),
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::TimedOut
                ) => {}
            Err(_) => return IoEnd::ReadFailed,
        }
    }
}

// ---------------------------------------------------------------------------
// The supervisor thread.
// ---------------------------------------------------------------------------

struct IoSide {
    rx: Option<Receiver<IoMsg>>,
    go_tx: Option<Sender<()>>,
    handle: Option<JoinHandle<()>>,
    socket: Option<TcpStream>,
    abort: Arc<AtomicBool>,
    inflight: Arc<AtomicUsize>,
    #[cfg(test)]
    hooks: Option<Arc<TransportTestHooks>>,
}

impl IoSide {
    /// Stop the I/O thread: tell it to abort, close the `GO` channel, shut the
    /// socket down (which wakes a blocked read or write) and join it for at
    /// most `limit`. On an overrun the thread is detached and every later
    /// message is thrown away with the receiver.
    fn stop(&mut self, limit: Duration) -> JoinOutcome {
        self.abort.store(true, Ordering::Release);
        self.go_tx = None;
        if let Some(socket) = self.socket.take() {
            #[cfg(test)]
            let suppressed = self
                .hooks
                .as_ref()
                .is_some_and(|hooks| hooks.suppress_shutdown.load(Ordering::Acquire));
            #[cfg(not(test))]
            let suppressed = false;
            if !suppressed {
                shutdown_both(&socket);
            }
        }
        let outcome = match self.handle.take() {
            Some(handle) => join_bounded(handle, limit),
            None => JoinOutcome::Joined,
        };
        if matches!(outcome, JoinOutcome::Overrun) {
            self.rx = None;
        }
        outcome
    }

    fn recv(&self, wait: Duration) -> Result<IoMsg, RecvTimeoutError> {
        match &self.rx {
            Some(rx) => rx.recv_timeout(wait),
            None => Err(RecvTimeoutError::Disconnected),
        }
    }

    fn release(&self, size: usize) {
        self.inflight.fetch_sub(size, Ordering::AcqRel);
    }
}

/// What the supervisor has seen of the response.
struct Accumulator {
    observer: OutputObserver,
    text: String,
    thinking: String,
}

impl Accumulator {
    /// Feed decoded events to the observer and the run. An observer error
    /// means the stream is invalid: the caller stops.
    fn consume(&mut self, events: Vec<WireEvent>, run: &RunShared) -> Result<(), ()> {
        let mut text_delta = String::new();
        let mut thinking_delta = String::new();
        let mut verdict = Ok(());
        for event in events {
            let step = match event {
                WireEvent::Text(piece) => {
                    let observed = self.observer.observe(OutputChannel::Text, piece.as_bytes());
                    // The observer hashes the bytes before it reports a prior
                    // error, except after a terminal; keep the audited text
                    // equal to what it hashed.
                    if !matches!(observed, Err(OutputObservationError::DataAfterTerminal)) {
                        self.text.push_str(&piece);
                        text_delta.push_str(&piece);
                    }
                    observed
                }
                WireEvent::Thinking(piece) => {
                    let observed = self
                        .observer
                        .observe(OutputChannel::Thinking, piece.as_bytes());
                    if !matches!(observed, Err(OutputObservationError::DataAfterTerminal)) {
                        self.thinking.push_str(&piece);
                        thinking_delta.push_str(&piece);
                    }
                    observed
                }
                WireEvent::Terminal(terminal) => self.observer.observe_terminal(terminal),
                WireEvent::Done => Ok(()),
            };
            if step.is_err() {
                verdict = Err(());
                break;
            }
        }
        run.push(&text_delta, &thinking_delta);
        verdict
    }
}

fn supervise(owner: Nir1TransportOwner, input: Nir1LocalGenerationInput, run: Arc<RunShared>) {
    let _guard = RunGuard(Arc::clone(&run));
    // 1. The target, payload and purpose the attempt bound.
    let bound = match verify_binding(&owner, &input) {
        Ok(bound) => bound,
        Err(reason) => return settle_without_send(owner, &run, reason),
    };
    let Nir1LocalGenerationInput {
        target,
        purpose,
        policy_basis,
        message_id,
        config,
        #[cfg(test)]
        hooks,
    } = input;
    let Ok(request_target) = target.request_target() else {
        return settle_without_send(owner, &run, "target-not-loopback-literal");
    };
    let Ok(timestamp_ms) = now_ms() else {
        return settle_without_send(owner, &run, "clock-unavailable");
    };

    // 2. The audit start: three events durable before any socket exists.
    let start = Nir1LocalAuditStart {
        request: bound.request,
        payload_digest: bound.payload_digest,
        socket: target.socket_addr().to_string(),
        policy_basis,
        timestamp_ms,
    };
    if owner.append_audit_start(&start).is_err() {
        return settle_without_send(owner, &run, "audit-start-failed");
    }
    // 3. The policy, read fresh and outside every lock cancel shares.
    let policy = owner.read_send_policy(purpose);
    // 4. Send decision 1, right before the connection.
    if let Nir1SendDecision::Refused(refusal) = owner.decide_send(&policy) {
        return settle_without_send(owner, &run, refusal_reason(refusal));
    }

    // 5. The I/O thread connects. It writes nothing until `GO`.
    let (tx, rx) = mpsc::sync_channel(config.channel_messages);
    let (go_tx, go_rx) = mpsc::channel();
    let abort = Arc::new(AtomicBool::new(false));
    let inflight = Arc::new(AtomicUsize::new(0));
    let plan = IoPlan {
        addr: target.socket_addr(),
        head: build_request_head(&request_target, bound.body.len()),
        body: bound.body,
        config,
        tx,
        go_rx,
        inflight: Arc::clone(&inflight),
        abort: Arc::clone(&abort),
        #[cfg(test)]
        hooks: hooks.clone(),
    };
    let spawned = thread::Builder::new()
        .name("nir1-local-io".into())
        .spawn(move || io_main(plan));
    let Ok(handle) = spawned else {
        return settle_without_send(owner, &run, "io-thread-spawn-failed");
    };
    let mut io = IoSide {
        rx: Some(rx),
        go_tx: Some(go_tx),
        handle: Some(handle),
        socket: None,
        abort,
        inflight,
        #[cfg(test)]
        hooks: hooks.clone(),
    };

    match await_connection(&owner, &mut io, &config) {
        Ok(socket) => io.socket = Some(socket),
        Err(reason) => return settle_before_go(owner, &mut io, &config, &run, reason),
    }
    // 6. Send decision 2, right before the first byte; then `GO`.
    if let Nir1SendDecision::Refused(refusal) = owner.decide_send(&policy) {
        return settle_before_go(owner, &mut io, &config, &run, refusal_reason(refusal));
    }
    let go_sent = io
        .go_tx
        .as_ref()
        .is_some_and(|go_tx| go_tx.send(()).is_ok());
    if !go_sent {
        return settle_before_go(owner, &mut io, &config, &run, "io-aborted");
    }
    // From here the request may have been written.
    let went_at = Instant::now();

    // 7. Observe.
    let mut accumulator = Accumulator {
        observer: OutputObserver::new(),
        text: String::new(),
        thinking: String::new(),
    };
    let watchdog = went_at + config.total_timeout + config.join_limit;
    let mut head_ok = false;
    let (completion, reason) = loop {
        match io.recv(config.cancel_poll) {
            Ok(IoMsg::Events { events, size }) => {
                io.release(size);
                if accumulator.consume(events, &run).is_err() {
                    break (Completion::ParseFailure, "observer-rejected");
                }
            }
            Ok(IoMsg::End { end, head_ok: ok }) => {
                head_ok = ok;
                break (end.completion(), end.reason());
            }
            Ok(IoMsg::Connected(_)) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                break (Completion::UnexpectedEof, "io-thread-gone");
            }
        }
        if owner.should_stop() || !owner.permit_is_open() {
            break (Completion::Cancelled, "cancelled");
        }
        if Instant::now() >= watchdog {
            break (Completion::UnexpectedEof, "watchdog");
        }
    };

    // 8. Close the socket and end the I/O thread (bounded), then drain what
    //    was already observed.
    let overran = matches!(io.stop(config.join_limit), JoinOutcome::Overrun);
    if overran {
        // The terminal write below does not depend on the quarantine.
        let _ = owner.quarantine_gate();
    } else if let Some(rx) = &io.rx {
        while let Ok(message) = rx.try_recv() {
            if let IoMsg::Events { events, size } = message {
                io.inflight.fetch_sub(size, Ordering::AcqRel);
                if accumulator.consume(events, &run).is_err() {
                    break;
                }
            }
        }
    }
    drop(io);

    // 9. The one terminal.
    write_terminal(
        owner,
        &run,
        accumulator,
        completion,
        reason,
        message_id,
        head_ok,
        overran,
    );
}

/// Wait for the I/O thread to connect, watching cancel and the entry.
fn await_connection(
    owner: &Nir1TransportOwner,
    io: &mut IoSide,
    config: &Nir1LocalTransportConfig,
) -> Result<TcpStream, &'static str> {
    let deadline = Instant::now() + config.connect_timeout + config.join_limit;
    loop {
        match io.recv(config.cancel_poll) {
            Ok(IoMsg::Connected(socket)) => return Ok(socket),
            Ok(IoMsg::End { end, .. }) => return Err(end.reason()),
            Ok(IoMsg::Events { .. }) => return Err("unexpected-message"),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err("io-thread-gone"),
        }
        if owner.should_stop() || !owner.permit_is_open() {
            return Err("stopped-before-connection");
        }
        if Instant::now() >= deadline {
            return Err("connect-overrun");
        }
    }
}

/// Close out an attempt whose `GO` was never given: nothing was sent, so the
/// terminal is the zero-send one. A join that overruns still quarantines.
fn settle_before_go(
    owner: Nir1TransportOwner,
    io: &mut IoSide,
    config: &Nir1LocalTransportConfig,
    run: &RunShared,
    reason: &'static str,
) {
    let overran = matches!(io.stop(config.join_limit), JoinOutcome::Overrun);
    if overran {
        let _ = owner.quarantine_gate();
    }
    let settlement = owner.settle_without_send();
    let state = match &settlement {
        Nir1Settlement::ZeroSend(terminal) => state_of_terminal(terminal),
        _ => Nir1LocalRunState::Failed,
    };
    run.finish(state, Nir1LocalRunEnd::Settled(settlement), reason, overran);
}

#[allow(clippy::too_many_arguments)]
fn write_terminal(
    owner: Nir1TransportOwner,
    run: &RunShared,
    accumulator: Accumulator,
    completion: Completion,
    reason: &'static str,
    message_id: String,
    head_ok: bool,
    overran: bool,
) {
    let Accumulator {
        observer,
        text,
        thinking,
    } = accumulator;
    let observation = observer.finish(completion);
    let succeeded = observation.terminal_status == TerminalStatus::Succeeded;
    let observed = Nir1LocalAuditObserved {
        text: text.clone(),
        thinking: thinking.clone(),
        usage: None,
        finish_reason: succeeded.then(|| "stop".to_owned()),
        http_status: head_ok.then_some(200),
    };
    let body = succeeded.then_some(NewMessageBody {
        message_id,
        content: text,
        thinking,
    });
    match owner.finish_with_audit(&observation, body, &observed) {
        Ok(terminal) => {
            let state = state_of_terminal(&terminal);
            run.finish(
                state,
                Nir1LocalRunEnd::Terminal(Box::new(terminal)),
                reason,
                overran,
            );
        }
        Err(Nir1FinishFailure { failure, durable }) => {
            let state = durable
                .as_deref()
                .map_or(Nir1LocalRunState::Failed, state_of_terminal);
            run.finish(
                state,
                Nir1LocalRunEnd::FinishFailed { failure, durable },
                reason,
                overran,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Test hooks.
// ---------------------------------------------------------------------------

/// Synchronization and fault points for tests only.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct TransportTestHooks {
    /// Replaces the peer address the I/O thread sees after connecting.
    pub(crate) peer_override: Mutex<Option<SocketAddr>>,
    /// The I/O thread does not end (and does not report) until released.
    pub(crate) wedge_io: AtomicBool,
    pub(crate) release_io: AtomicBool,
    /// The supervisor does not shut the socket down (an OS where that does
    /// not wake a blocked read): the I/O thread must still end by itself.
    pub(crate) suppress_shutdown: AtomicBool,
    /// Set when the I/O thread function returned.
    pub(crate) io_exited: AtomicBool,
}

#[cfg(test)]
impl TransportTestHooks {
    fn wedge_before_end(&self) {
        // A safety bound so a failed test cannot leak the thread forever.
        let limit = Instant::now() + Duration::from_secs(30);
        while self.wedge_io.load(Ordering::Acquire)
            && !self.release_io.load(Ordering::Acquire)
            && Instant::now() < limit
        {
            thread::sleep(Duration::from_millis(2));
        }
    }
}

#[cfg(test)]
#[path = "nir1_local_transport_tests.rs"]
mod tests;
