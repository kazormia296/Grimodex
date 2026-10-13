//! Internal NIR-1 generation attempt owner (DT-2). No N-API entry, IPC route
//! or production transport exists; DT-5 supplies the transport.
//!
//! One owner serves one accepted current Human submission:
//!
//! 1. `capture` pins the exact Ready workspace (participant), a counted
//!    profile dispatch permit and one in-flight registry slot per chat
//!    session, while the startup gate is Open for that binding.
//! 2. `create` writes the attempt with a deterministic ID under a startup
//!    lease, through the bounded admission writer (mutex 100 ms, busy 100 ms,
//!    per-op 250 ms; the lease and permit are an atomic probe).
//! 3. `claim_for_transport` consumes the one-shot claim the same way. COMMIT
//!    runs with no Core, profile, participant or owner mutex held. After
//!    COMMIT the owner revalidates profile, route, workspace, Core binding and
//!    lease, then linearizes the start decision with `cancel` on its phase
//!    mutex. Only a `Started` owner may use a transport.
//!
//! Every stop before the start decision writes exactly one transport-less
//! (zero-send) terminal through the pinned writer, which observes neither the
//! owner's cancel nor lifecycle stops. An unknown COMMIT outcome is resolved
//! by an exact bounded reread; if that also fails the gate entry is
//! quarantined and the session slot stays unresolved until a later Ready
//! entry's sweep has terminalized the attempt.

#![cfg_attr(not(test), allow(dead_code))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_nir1_receipt::TerminalObservation;
use grimodex_db::nir1_generation::{
    self as storage, AcceptedChatInputCapture, AttemptBinding, NewAttempt, NewMessageBody,
    Nir1AdmissionProbe, Nir1AdmissionSqlBudget, Nir1ClaimOutcome, Nir1CommitState,
    Nir1ExpectedAttempt, Nir1ExpectedClaim, Nir1PinnedSqlBudget, Nir1StoreFailure,
    Nir1ZeroSendCompletion, StoredTerminal,
};
use grimodex_db::state::{active_workspace_snapshot, ActiveWorkspaceSnapshot};
use grimodex_db::workspace_lifecycle::{LifecycleState, LiveBinding};

use crate::nir1_generation::{
    canonical_final_payload, final_input_digest, now_ms, route_revision, FinalDispatchRequest,
};
use crate::nir1_prepared_request::NativeAcceptedChatSubmission;
use crate::nir1_startup_barrier::{Nir1EntryWitness, Nir1StartupAdmissionGate, Nir1StartupLease};
use crate::profile_egress::{CallerIdentity, ProfileDispatchPermit};
use crate::state::{AppState, WorkspaceOperationGuard};

/// Upper bound for tracked chat sessions (in flight plus unresolved). Checked
/// before a slot is allocated; a full registry refuses new submissions.
pub(crate) const NIR1_GENERATION_MAX_TRACKED_SESSIONS: usize = 16;
/// Upper bound for writes of one zero-send terminal (each <= 250 ms).
pub(crate) const NIR1_ZERO_SEND_TERMINAL_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
#[non_exhaustive]
pub(crate) enum Nir1GenerationRefusal {
    WorkspaceNotReady,
    WorkspaceUnavailable,
    /// The startup gate is not Open for the exact Ready binding.
    GateClosed,
    ProfileRevoked,
    RouteChanged,
    Cancelled,
    SubmissionMismatch,
    SubmissionNotCurrent,
    /// The same submission already has an in-flight owner.
    SameSubmissionInFlight {
        attempt_id: String,
    },
    /// Another submission of the same chat session is in flight.
    SessionBusy,
    /// An earlier attempt of the session is unresolved until the next sweep.
    SessionUnresolved {
        attempt_id: String,
    },
    /// The submission's deterministic attempt already exists. It is never
    /// recreated; `settled` reports whether its terminal is durable.
    SubmissionAlreadyAttempted {
        attempt_id: String,
        settled: bool,
    },
    InFlightCapacity,
    RegistryUnavailable,
    Store(Nir1StoreFailure),
    /// The create COMMIT outcome could not be resolved; the gate entry is
    /// quarantined and the session slot is unresolved.
    Unresolved {
        attempt_id: String,
    },
}

/// Outcome of an owner that did not start a transport.
#[derive(Debug)]
pub(crate) enum Nir1Settlement {
    /// This owner's zero-send terminal is durable (an idempotent rewrite of
    /// the same terminal included).
    ZeroSend(Box<StoredTerminal>),
    /// Another terminal is already durable (the claim saw a terminal, or the
    /// zero-send writer reported a different terminal).
    AlreadySettled,
    /// Another claimer holds the claim; no terminal was written by this owner.
    ClaimLost,
    /// The session slot is unresolved. `gate_quarantined` is true only when a
    /// COMMIT outcome could not be resolved; after exhausted zero-send writes
    /// the gate stays Open (the state is known, nothing was sent, and the
    /// next Ready entry's sweep terminalizes the attempt).
    Unresolved {
        attempt_id: String,
        gate_quarantined: bool,
    },
}

pub(crate) enum Nir1TransportDecision {
    Start(Nir1TransportOwner),
    NotStarted(Nir1Settlement),
}

// ---------------------------------------------------------------------------
// Process-local in-flight registry.
// ---------------------------------------------------------------------------

/// Exact Ready binding plus the DB-validated chat session of the capture.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Nir1SessionKey {
    binding: LiveBinding,
    project_id: String,
    chat_session_id: String,
}

enum Nir1SessionSlot {
    InFlight {
        submission_id: String,
        attempt_id: String,
        token: u64,
    },
    Unresolved {
        attempt_id: String,
        marked_epoch: u64,
    },
}

#[derive(Default)]
struct RegistryState {
    slots: Vec<(Nir1SessionKey, Nir1SessionSlot)>,
    next_token: u64,
}

/// One in-flight attempt per chat session. Process-local: a restart starts
/// empty, and the durable attempt rows are terminalized by the next Ready
/// entry's sweep before the startup gate opens.
#[derive(Clone, Default)]
pub(crate) struct Nir1GenerationRegistry {
    inner: Arc<Mutex<RegistryState>>,
}

impl Nir1GenerationRegistry {
    /// Reserve the session slot. `open_entry_epoch` is the gate epoch of the
    /// Open entry, read before this mutex: an unresolved slot marked before
    /// that entry is released, because the entry's sweep has terminalized it.
    fn reserve(
        &self,
        key: Nir1SessionKey,
        submission_id: &str,
        attempt_id: &str,
        open_entry_epoch: Option<u64>,
    ) -> Result<Nir1SessionSlotGuard, Nir1GenerationRefusal> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| Nir1GenerationRefusal::RegistryUnavailable)?;
        if let Some(open) = open_entry_epoch {
            state.slots.retain(|(_, slot)| {
                !matches!(slot, Nir1SessionSlot::Unresolved { marked_epoch, .. } if *marked_epoch < open)
            });
        }
        if let Some((_, slot)) = state.slots.iter().find(|(current, _)| *current == key) {
            return Err(match slot {
                Nir1SessionSlot::InFlight {
                    submission_id: current,
                    attempt_id,
                    ..
                } if current == submission_id => Nir1GenerationRefusal::SameSubmissionInFlight {
                    attempt_id: attempt_id.clone(),
                },
                Nir1SessionSlot::InFlight { .. } => Nir1GenerationRefusal::SessionBusy,
                Nir1SessionSlot::Unresolved { attempt_id, .. } => {
                    Nir1GenerationRefusal::SessionUnresolved {
                        attempt_id: attempt_id.clone(),
                    }
                }
            });
        }
        if state.slots.len() >= NIR1_GENERATION_MAX_TRACKED_SESSIONS {
            return Err(Nir1GenerationRefusal::InFlightCapacity);
        }
        let token = state.next_token;
        state.next_token = token
            .checked_add(1)
            .ok_or(Nir1GenerationRefusal::RegistryUnavailable)?;
        state.slots.push((
            key,
            Nir1SessionSlot::InFlight {
                submission_id: submission_id.to_owned(),
                attempt_id: attempt_id.to_owned(),
                token,
            },
        ));
        Ok(Nir1SessionSlotGuard {
            registry: Arc::clone(&self.inner),
            token,
            armed: true,
        })
    }

    #[cfg(test)]
    pub(crate) fn tracked_sessions(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .slots
            .len()
    }

    #[cfg(test)]
    pub(crate) fn unresolved_attempts(&self) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .slots
            .iter()
            .filter_map(|(_, slot)| match slot {
                Nir1SessionSlot::Unresolved { attempt_id, .. } => Some(attempt_id.clone()),
                Nir1SessionSlot::InFlight { .. } => None,
            })
            .collect()
    }
}

/// Releases its in-flight slot on Drop, unless consumed by `mark_unresolved`.
pub(crate) struct Nir1SessionSlotGuard {
    registry: Arc<Mutex<RegistryState>>,
    token: u64,
    armed: bool,
}

impl Nir1SessionSlotGuard {
    /// Keep the session refused until the Open entry after `epoch` (read
    /// from the gate just before this call, outside this mutex).
    fn mark_unresolved(mut self, epoch: u64) {
        self.armed = false;
        let mut state = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some((_, slot)) = state.slots.iter_mut().find(|(_, slot)| {
            matches!(slot, Nir1SessionSlot::InFlight { token, .. } if *token == self.token)
        }) {
            if let Nir1SessionSlot::InFlight { attempt_id, .. } = slot {
                let attempt_id = std::mem::take(attempt_id);
                *slot = Nir1SessionSlot::Unresolved {
                    attempt_id,
                    marked_epoch: epoch,
                };
            }
        }
    }
}

impl Drop for Nir1SessionSlotGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let mut state = self.registry.lock().unwrap_or_else(PoisonError::into_inner);
        state.slots.retain(|(_, slot)| {
            !matches!(slot, Nir1SessionSlot::InFlight { token, .. } if *token == self.token)
        });
    }
}

// ---------------------------------------------------------------------------
// Owner control: cancel and the start decision share one short mutex.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Nir1OwnerPhase {
    Pending,
    Started,
}

pub(crate) struct Nir1OwnerControl {
    cancel: Arc<AtomicBool>,
    phase: Mutex<Nir1OwnerPhase>,
    #[cfg(test)]
    hooks: test_hooks::Nir1OwnerTestHooks,
}

impl Nir1OwnerControl {
    fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            phase: Mutex::new(Nir1OwnerPhase::Pending),
            #[cfg(test)]
            hooks: test_hooks::Nir1OwnerTestHooks::default(),
        }
    }

    fn cancel_requested(&self) -> bool {
        self.cancel.load(Ordering::Acquire)
    }

    fn lock_phase(&self) -> MutexGuard<'_, Nir1OwnerPhase> {
        self.phase.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Cancel handle. Before the start decision, cancel makes the owner write a
/// `Cancelled` zero-send terminal; after it, DT-5 closes the transport.
#[derive(Clone)]
pub(crate) struct Nir1OwnerCancel {
    control: Arc<Nir1OwnerControl>,
}

impl Nir1OwnerCancel {
    /// Touches only the stop flag and the phase mutex; never the database.
    pub(crate) fn cancel(&self) {
        let _phase = self.control.lock_phase();
        self.control.cancel.store(true, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Owner states.
// ---------------------------------------------------------------------------

/// Everything an owner pins for its whole life. The workspace snapshot keeps
/// the lifecycle participant counted, so a transition's physical exclusive
/// waits for this owner to settle and drop.
struct OwnerCore {
    state: Arc<AppState>,
    permit: ProfileDispatchPermit,
    caller: CallerIdentity,
    live_binding: LiveBinding,
    workspace_digest: String,
    route_revision: String,
    capture: AcceptedChatInputCapture,
    attempt_id: String,
    control: Arc<Nir1OwnerControl>,
    workspace: ActiveWorkspaceSnapshot,
    _operation: WorkspaceOperationGuard,
}

enum UnknownClaim {
    Own(i64),
    Terminal,
    Other,
    Unclaimed,
    Unresolved,
}

impl OwnerCore {
    fn gate(&self) -> &Nir1StartupAdmissionGate {
        self.state.workspace_lifecycle.nir1_startup_gate()
    }

    #[cfg(test)]
    fn fire(&self, point: Nir1OwnerProbePoint) {
        self.control.hooks.fire(point);
    }

    fn record_failure(&self, _stage: &'static str, _failure: Nir1StoreFailure) {
        #[cfg(test)]
        self.control.hooks.record_failure(_stage, _failure);
    }

    /// Admission budget fenced by the lease and the permit, read lock-free.
    fn admission_budget(
        &self,
        lease: &Nir1StartupLease,
        _stage: &'static str,
    ) -> Nir1AdmissionSqlBudget {
        let witness = lease.witness();
        let permit = self.permit.clone();
        let probe: Nir1AdmissionProbe =
            Arc::new(move || witness.is_current() && permit.ensure_open().is_ok());
        let budget = Nir1AdmissionSqlBudget::new(Arc::clone(&self.control.cancel), probe);
        #[cfg(test)]
        let budget = self.control.hooks.decorate_admission(_stage, budget);
        budget
    }

    fn pinned_budget(&self) -> Nir1PinnedSqlBudget {
        Nir1PinnedSqlBudget::new()
    }

    fn route_is_current(&self) -> bool {
        route_revision(&self.state).is_ok_and(|revision| revision == self.route_revision)
    }

    fn mark_unresolved(&self, slot: Nir1SessionSlotGuard) {
        slot.mark_unresolved(self.gate().current_epoch());
    }

    /// Write this owner's zero-send terminal, at most
    /// `NIR1_ZERO_SEND_TERMINAL_ATTEMPTS` times. The completion is decided
    /// once: `Cancelled` if cancel was requested, otherwise `DispatchFailure`.
    fn settle_zero_send(
        &self,
        slot: Nir1SessionSlotGuard,
        expected: &Nir1ExpectedAttempt,
        claim: Nir1ExpectedClaim,
    ) -> Nir1Settlement {
        let completion = if self.control.cancel_requested() {
            Nir1ZeroSendCompletion::Cancelled
        } else {
            Nir1ZeroSendCompletion::DispatchFailure
        };
        for _ in 0..NIR1_ZERO_SEND_TERMINAL_ATTEMPTS {
            #[cfg(test)]
            self.fire(Nir1OwnerProbePoint::BeforeZeroSend);
            match storage::finish_pretransport_attempt_bounded(
                &self.workspace,
                expected,
                claim,
                completion,
                &self.pinned_budget(),
            ) {
                Ok(terminal) => return Nir1Settlement::ZeroSend(Box::new(terminal)),
                Err(error) => {
                    self.record_failure("zero-send", error.failure());
                    match error.failure() {
                        Nir1StoreFailure::TerminalConflict => {
                            return Nir1Settlement::AlreadySettled
                        }
                        Nir1StoreFailure::ClaimMismatch => return Nir1Settlement::ClaimLost,
                        // The writer is idempotent, so an earlier write that
                        // became durable is returned, never duplicated.
                        Nir1StoreFailure::ConnectionBusy
                        | Nir1StoreFailure::SqliteBusy
                        | Nir1StoreFailure::TimedOut
                        | Nir1StoreFailure::ConnectionUnavailable => continue,
                        _ if error.commit() == Nir1CommitState::Unknown => continue,
                        _ => break,
                    }
                }
            }
        }
        self.mark_unresolved(slot);
        Nir1Settlement::Unresolved {
            attempt_id: expected.id.clone(),
            gate_quarantined: false,
        }
    }

    /// Resolve an unknown claim COMMIT by the exact bounded reread. `written`
    /// is the claim time this owner's transaction used.
    fn resolve_unknown_claim(
        &self,
        expected: &Nir1ExpectedAttempt,
        written: Option<i64>,
    ) -> UnknownClaim {
        match storage::read_attempt_exact_bounded(
            &self.workspace,
            &expected.id,
            expected.read_budget,
            &self.pinned_budget(),
        ) {
            Ok(Some(attempt)) if expected.matches(&attempt) => {
                if attempt.terminal.is_some() {
                    UnknownClaim::Terminal
                } else {
                    match attempt.claimed_at_ms {
                        Some(claimed_at_ms) if Some(claimed_at_ms) == written => {
                            UnknownClaim::Own(claimed_at_ms)
                        }
                        Some(_) => UnknownClaim::Other,
                        None => UnknownClaim::Unclaimed,
                    }
                }
            }
            // Immutable fields changed under this owner: fail closed.
            Ok(Some(_)) => UnknownClaim::Unresolved,
            // A confirmed absence: nothing to send. The zero-send writer then
            // reports `Missing` and the slot stays unresolved.
            Ok(None) => UnknownClaim::Unclaimed,
            Err(error) => {
                self.record_failure("reread", error.failure());
                UnknownClaim::Unresolved
            }
        }
    }

    /// Post-COMMIT revalidation before the start decision. Each step takes at
    /// most one short lock; the DB mutex is not held.
    fn revalidate(&self, lease: &Nir1StartupLease) -> bool {
        self.state
            .profile_egress
            .with_authorized_dispatch(
                &self.permit,
                Some(&self.caller),
                Some(&self.live_binding.locator),
                || Ok(()),
            )
            .is_ok()
            && self.route_is_current()
            && storage::ensure_attempt_workspace_current(&self.workspace).is_ok()
            && ready_binding(&self.state).is_ok_and(|binding| &binding == lease.binding())
            && lease.is_current()
    }
}

/// An accepted submission's owner before its attempt exists.
pub(crate) struct Nir1GenerationOwner {
    core: OwnerCore,
    slot: Nir1SessionSlotGuard,
}

/// A durable attempt that is not claimed by this owner yet. Dropping it
/// unconsumed writes the same zero-send terminal as `abandon`.
pub(crate) struct Nir1PreparedAttempt {
    inner: Option<PreparedInner>,
}

struct PreparedInner {
    core: OwnerCore,
    slot: Nir1SessionSlotGuard,
    expected: Nir1ExpectedAttempt,
    canonical_payload: String,
}

/// One-shot transport capability for a claimed attempt whose start decision
/// passed. Dropping it without `finish` records `InterruptedUnknown` once.
pub(crate) struct Nir1TransportOwner {
    inner: Option<Box<TransportInner>>,
}

struct TransportInner {
    core: OwnerCore,
    slot: Nir1SessionSlotGuard,
    expected: Nir1ExpectedAttempt,
    canonical_payload: String,
    claimed_at_ms: i64,
    witness: Nir1EntryWitness,
}

/// Refusal for a create whose attempt is known not to be durable: a
/// NotCommitted create, or an unknown COMMIT that the exact reread resolved
/// to a confirmed absence. Both paths map one failure the same way.
fn create_refusal(failure: Nir1StoreFailure) -> Nir1GenerationRefusal {
    match failure {
        Nir1StoreFailure::NotCurrent => Nir1GenerationRefusal::SubmissionNotCurrent,
        Nir1StoreFailure::Cancelled => Nir1GenerationRefusal::Cancelled,
        failure => Nir1GenerationRefusal::Store(failure),
    }
}

fn ready_binding(state: &AppState) -> Result<LiveBinding, Nir1GenerationRefusal> {
    let lifecycle = state
        .ws
        .lifecycle_core()
        .snapshot()
        .map_err(|_| Nir1GenerationRefusal::WorkspaceUnavailable)?;
    match lifecycle.state {
        LifecycleState::Ready(binding) => Ok(binding),
        _ => Err(Nir1GenerationRefusal::WorkspaceNotReady),
    }
}

impl Nir1GenerationOwner {
    /// Pin the exact Ready workspace, the profile permit and the session slot
    /// for one accepted submission. Short locks are taken one at a time:
    /// permit, Core, gate, participant, profile, gate, registry.
    pub(crate) fn capture(
        state: Arc<AppState>,
        caller: CallerIdentity,
        submission: &NativeAcceptedChatSubmission,
    ) -> Result<Self, Nir1GenerationRefusal> {
        let operation = state
            .begin_workspace_operation()
            .map_err(|_| Nir1GenerationRefusal::WorkspaceUnavailable)?;
        let permit = state
            .profile_egress
            .begin_dispatch(Some(&caller))
            .map_err(|_| Nir1GenerationRefusal::ProfileRevoked)?;
        let live_binding = ready_binding(&state)?;
        let gate = state.workspace_lifecycle.nir1_startup_gate();
        let lease = gate
            .try_lease_for_binding(&live_binding)
            .ok_or(Nir1GenerationRefusal::GateClosed)?;
        let workspace = active_workspace_snapshot(&state.ws)
            .map_err(|_| Nir1GenerationRefusal::WorkspaceNotReady)?;
        if workspace.db().identity() != live_binding.authority_instance
            || workspace.path().to_string_lossy().as_ref() != live_binding.locator.as_ref()
            || ready_binding(&state)? != live_binding
        {
            return Err(Nir1GenerationRefusal::WorkspaceNotReady);
        }
        let capture: AcceptedChatInputCapture = (**submission).clone();
        // Legacy AttemptBinding shape (DT-3 separates them): the caller's
        // session is the DB-validated chat session of this capture.
        if capture.chat_session_id() != caller.session_id {
            return Err(Nir1GenerationRefusal::SubmissionMismatch);
        }
        let route = state
            .profile_egress
            .with_authorized_dispatch(&permit, Some(&caller), Some(&live_binding.locator), || {
                Ok(route_revision(&state))
            })
            .map_err(|_| Nir1GenerationRefusal::ProfileRevoked)?
            .map_err(|_| Nir1GenerationRefusal::RouteChanged)?;
        let attempt_id = storage::attempt_id_for_capture(&capture)
            .map_err(|_| Nir1GenerationRefusal::Store(Nir1StoreFailure::Invalid))?;
        let workspace_digest = serde_json::to_value(&live_binding)
            .ok()
            .and_then(|value| canonical_json_digest(&value).ok())
            .ok_or(Nir1GenerationRefusal::Store(Nir1StoreFailure::Invalid))?;
        let key = Nir1SessionKey {
            binding: live_binding.clone(),
            project_id: capture.project_id().to_owned(),
            chat_session_id: capture.chat_session_id().to_owned(),
        };
        let open_entry_epoch = gate.open_entry_epoch();
        let slot = state.nir1_generation_registry.reserve(
            key,
            capture.submission_id(),
            &attempt_id,
            open_entry_epoch,
        )?;
        drop(lease);
        Ok(Self {
            core: OwnerCore {
                state,
                permit,
                caller,
                live_binding,
                workspace_digest,
                route_revision: route,
                capture,
                attempt_id,
                control: Arc::new(Nir1OwnerControl::new()),
                workspace,
                _operation: operation,
            },
            slot,
        })
    }

    pub(crate) fn cancel_handle(&self) -> Nir1OwnerCancel {
        Nir1OwnerCancel {
            control: Arc::clone(&self.core.control),
        }
    }

    pub(crate) fn attempt_id(&self) -> &str {
        &self.core.attempt_id
    }

    pub(crate) fn route_revision(&self) -> &str {
        &self.core.route_revision
    }

    /// Persist the final request as this submission's attempt. Only the
    /// canonical payload digest is stored; the payload stays in the returned
    /// in-process handle.
    pub(crate) fn create(
        self,
        request: FinalDispatchRequest,
    ) -> Result<Nir1PreparedAttempt, Nir1GenerationRefusal> {
        let Self { core, slot } = self;
        if core.control.cancel_requested() {
            return Err(Nir1GenerationRefusal::Cancelled);
        }
        core.permit
            .ensure_open()
            .map_err(|_| Nir1GenerationRefusal::ProfileRevoked)?;
        if request.route_revision != core.route_revision {
            return Err(Nir1GenerationRefusal::RouteChanged);
        }
        if request.project_id != core.capture.project_id() {
            return Err(Nir1GenerationRefusal::SubmissionMismatch);
        }
        let (canonical_payload, payload_digest) = canonical_final_payload(&request.payload)
            .map_err(|_| Nir1GenerationRefusal::Store(Nir1StoreFailure::Invalid))?;
        let input_digest = final_input_digest(&request.inputs, &request.qualifications)
            .map_err(|_| Nir1GenerationRefusal::Store(Nir1StoreFailure::Invalid))?;
        let read_budget = request.budget;
        let binding = AttemptBinding {
            project_id: request.project_id,
            session_id: core.caller.session_id.clone(),
            profile_id: core.caller.profile_id.clone(),
            caller_id: core.caller.caller_id.clone(),
            caller_epoch: core.caller.caller_epoch,
            workspace_binding_digest: core.workspace_digest.clone(),
            purpose: request.purpose,
            scope_digest: request.scope_digest,
            material_digest: request.material_digest,
            d1_digest: request.d1_digest,
            route_revision: core.route_revision.clone(),
            provider: request.provider,
            model: request.model,
            api: request.api,
            endpoint_identity: request.endpoint_identity,
        };
        let attempt = NewAttempt {
            binding: binding.clone(),
            payload_digest: payload_digest.clone(),
            inputs: request.inputs,
            qualifications: request.qualifications,
            created_at_ms: request.created_at_ms,
            expires_at_ms: request.expires_at_ms,
            budget: read_budget,
        };
        let lease = core
            .gate()
            .try_lease_for_binding(&core.live_binding)
            .ok_or(Nir1GenerationRefusal::GateClosed)?;
        let witness = lease.witness();
        let budget = core.admission_budget(&lease, "create");
        let result = {
            let control = &core.control;
            let permit = &core.permit;
            let lease = &lease;
            let mut pre_commit = || -> anyhow::Result<()> {
                #[cfg(test)]
                control.hooks.fire(Nir1OwnerProbePoint::BeforePreCommit);
                anyhow::ensure!(!control.cancel_requested(), "NIR1_GENERATION_CANCELLED");
                anyhow::ensure!(lease.is_current(), "NIR1_GENERATION_LEASE_LOST");
                permit.ensure_open()?;
                #[cfg(test)]
                control.hooks.fire(Nir1OwnerProbePoint::AfterPreCommit);
                Ok(())
            };
            storage::create_attempt_for_capture_bounded(
                &core.workspace,
                &core.capture,
                attempt,
                &budget,
                &mut pre_commit,
            )
        };
        // The lease covers one bounded operation only.
        drop(lease);
        let error = match result {
            Ok(stored) => {
                let expected = Nir1ExpectedAttempt::from_stored(&stored, read_budget);
                return Ok(Nir1PreparedAttempt::new(
                    core,
                    slot,
                    expected,
                    canonical_payload,
                ));
            }
            Err(error) => error,
        };
        core.record_failure("create", error.failure());
        if error.commit() == Nir1CommitState::NotCommitted {
            return Err(match error.failure() {
                Nir1StoreFailure::AlreadyExists => {
                    let settled = storage::read_attempt_exact_bounded(
                        &core.workspace,
                        &core.attempt_id,
                        read_budget,
                        &core.pinned_budget(),
                    )
                    .ok()
                    .flatten()
                    .is_some_and(|attempt| attempt.terminal.is_some());
                    Nir1GenerationRefusal::SubmissionAlreadyAttempted {
                        attempt_id: core.attempt_id.clone(),
                        settled,
                    }
                }
                failure => create_refusal(failure),
            });
        }
        #[cfg(test)]
        core.fire(Nir1OwnerProbePoint::AfterCommit);
        match storage::read_attempt_exact_bounded(
            &core.workspace,
            &core.attempt_id,
            read_budget,
            &core.pinned_budget(),
        ) {
            Ok(Some(stored))
                if stored.binding == binding
                    && stored.payload_digest == payload_digest
                    && stored.input_digest == input_digest =>
            {
                let expected = Nir1ExpectedAttempt::from_stored(&stored, read_budget);
                Ok(Nir1PreparedAttempt::new(
                    core,
                    slot,
                    expected,
                    canonical_payload,
                ))
            }
            Ok(Some(stored)) => Err(Nir1GenerationRefusal::SubmissionAlreadyAttempted {
                attempt_id: core.attempt_id.clone(),
                settled: stored.terminal.is_some(),
            }),
            // A confirmed absence: nothing of this create is durable, so it is
            // refused exactly like a NotCommitted create.
            Ok(None) => Err(create_refusal(error.failure())),
            Err(reread) => {
                core.record_failure("reread", reread.failure());
                core.gate().quarantine_entry(&witness);
                let attempt_id = core.attempt_id.clone();
                core.mark_unresolved(slot);
                Err(Nir1GenerationRefusal::Unresolved { attempt_id })
            }
        }
    }
}

impl Nir1PreparedAttempt {
    fn new(
        core: OwnerCore,
        slot: Nir1SessionSlotGuard,
        expected: Nir1ExpectedAttempt,
        canonical_payload: String,
    ) -> Self {
        Self {
            inner: Some(PreparedInner {
                core,
                slot,
                expected,
                canonical_payload,
            }),
        }
    }

    fn inner(&self) -> &PreparedInner {
        self.inner
            .as_ref()
            .expect("a prepared attempt is consumed exactly once")
    }

    pub(crate) fn attempt_id(&self) -> &str {
        &self.inner().expected.id
    }

    pub(crate) fn cancel_handle(&self) -> Nir1OwnerCancel {
        Nir1OwnerCancel {
            control: Arc::clone(&self.inner().core.control),
        }
    }

    /// Claim and decide whether a transport may start. Every stop before the
    /// start decision settles with exactly one zero-send terminal.
    pub(crate) fn claim_for_transport(mut self) -> Nir1TransportDecision {
        self.inner
            .take()
            .expect("a prepared attempt is consumed exactly once")
            .claim_for_transport()
    }

    /// Give up before claiming: `Cancelled` after cancel, otherwise
    /// `DispatchFailure`.
    pub(crate) fn abandon(mut self) -> Nir1Settlement {
        let inner = self
            .inner
            .take()
            .expect("a prepared attempt is consumed exactly once");
        inner
            .core
            .settle_zero_send(inner.slot, &inner.expected, Nir1ExpectedClaim::Unclaimed)
    }
}

impl Drop for Nir1PreparedAttempt {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            // Drop cannot report; an unresolved result stays in the slot.
            let _ = inner.core.settle_zero_send(
                inner.slot,
                &inner.expected,
                Nir1ExpectedClaim::Unclaimed,
            );
        }
    }
}

impl PreparedInner {
    fn claim_for_transport(self) -> Nir1TransportDecision {
        let PreparedInner {
            core,
            slot,
            expected,
            canonical_payload,
        } = self;
        let gate = core.gate();
        // 1. A lease from the Open entry of this exact binding.
        let Some(mut lease) = gate.try_lease_for_binding(&core.live_binding) else {
            return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                slot,
                &expected,
                Nir1ExpectedClaim::Unclaimed,
            ));
        };
        // 2. Checks before BEGIN.
        if core.permit.ensure_open().is_err()
            || !core.route_is_current()
            || core.control.cancel_requested()
        {
            drop(lease);
            return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                slot,
                &expected,
                Nir1ExpectedClaim::Unclaimed,
            ));
        }
        // 3. The bounded claim. COMMIT holds no Core/profile/owner mutex.
        let witness = lease.witness();
        let budget = core.admission_budget(&lease, "claim");
        let claimed = {
            let control = &core.control;
            let permit = &core.permit;
            let lease = &lease;
            let mut pre_commit = || -> anyhow::Result<()> {
                #[cfg(test)]
                control.hooks.fire(Nir1OwnerProbePoint::BeforePreCommit);
                anyhow::ensure!(!control.cancel_requested(), "NIR1_GENERATION_CANCELLED");
                anyhow::ensure!(lease.is_current(), "NIR1_GENERATION_LEASE_LOST");
                permit.ensure_open()
            };
            storage::claim_attempt_bounded(&core.workspace, &expected, &budget, &mut pre_commit)
        };
        let claimed_at_ms = match claimed {
            Ok(Nir1ClaimOutcome::Claimed { claimed_at_ms }) => {
                #[cfg(test)]
                core.fire(Nir1OwnerProbePoint::AfterCommit);
                claimed_at_ms
            }
            // This owner has not claimed: the claim belongs to someone else.
            Ok(Nir1ClaimOutcome::AlreadyClaimed { .. }) => {
                return Nir1TransportDecision::NotStarted(Nir1Settlement::ClaimLost);
            }
            Ok(Nir1ClaimOutcome::AlreadyTerminal) => {
                return Nir1TransportDecision::NotStarted(Nir1Settlement::AlreadySettled);
            }
            Err(error) if error.commit() == Nir1CommitState::NotCommitted => {
                core.record_failure("claim", error.failure());
                drop(lease);
                return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                    slot,
                    &expected,
                    Nir1ExpectedClaim::Unclaimed,
                ));
            }
            Err(error) => {
                // 4. Unknown outcome: drop the lease, then reread exactly.
                core.record_failure("claim", error.failure());
                drop(lease);
                #[cfg(test)]
                core.fire(Nir1OwnerProbePoint::AfterCommit);
                match core.resolve_unknown_claim(&expected, error.claim_written_at_ms()) {
                    UnknownClaim::Own(claimed_at_ms) => {
                        match gate.try_lease_for_witness(&witness) {
                            // Only the same entry: a later entry's sweep may
                            // already have terminalized this claimed attempt.
                            Some(again) => {
                                lease = again;
                                claimed_at_ms
                            }
                            None => {
                                return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                                    slot,
                                    &expected,
                                    Nir1ExpectedClaim::ClaimedAt(claimed_at_ms),
                                ));
                            }
                        }
                    }
                    UnknownClaim::Terminal => {
                        return Nir1TransportDecision::NotStarted(Nir1Settlement::AlreadySettled);
                    }
                    UnknownClaim::Other => {
                        return Nir1TransportDecision::NotStarted(Nir1Settlement::ClaimLost);
                    }
                    UnknownClaim::Unclaimed => {
                        return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                            slot,
                            &expected,
                            Nir1ExpectedClaim::Unclaimed,
                        ));
                    }
                    UnknownClaim::Unresolved => {
                        gate.quarantine_entry(&witness);
                        core.mark_unresolved(slot);
                        return Nir1TransportDecision::NotStarted(Nir1Settlement::Unresolved {
                            attempt_id: expected.id.clone(),
                            gate_quarantined: true,
                        });
                    }
                }
            }
        };
        // 5. Post-COMMIT revalidation with the lease held, DB mutex released.
        let revalidated = core.revalidate(&lease);
        #[cfg(test)]
        core.fire(Nir1OwnerProbePoint::BeforeDecision);
        // 6. The start decision, linearized with cancel.
        let started = revalidated && {
            let mut phase = core.control.lock_phase();
            let start = !core.control.cancel_requested()
                && core.permit.ensure_open().is_ok()
                && lease.is_current();
            if start {
                *phase = Nir1OwnerPhase::Started;
            }
            start
        };
        let witness = lease.witness();
        // 7. Never hold the lease into a terminal write or a transport.
        drop(lease);
        if !started {
            return Nir1TransportDecision::NotStarted(core.settle_zero_send(
                slot,
                &expected,
                Nir1ExpectedClaim::ClaimedAt(claimed_at_ms),
            ));
        }
        Nir1TransportDecision::Start(Nir1TransportOwner {
            inner: Some(Box::new(TransportInner {
                core,
                slot,
                expected,
                canonical_payload,
                claimed_at_ms,
                witness,
            })),
        })
    }
}

impl Nir1TransportOwner {
    fn inner(&self) -> &TransportInner {
        self.inner
            .as_ref()
            .expect("a transport owner finishes exactly once")
    }

    pub(crate) fn canonical_payload(&self) -> &str {
        &self.inner().canonical_payload
    }

    pub(crate) fn attempt_id(&self) -> &str {
        &self.inner().expected.id
    }

    pub(crate) fn claimed_at_ms(&self) -> i64 {
        self.inner().claimed_at_ms
    }

    pub(crate) fn cancel_handle(&self) -> Nir1OwnerCancel {
        Nir1OwnerCancel {
            control: Arc::clone(&self.inner().core.control),
        }
    }

    /// The transport must stop: cancel was requested or the entry it started
    /// under has been replaced (a lifecycle edge or a quarantine).
    pub(crate) fn should_stop(&self) -> bool {
        let inner = self.inner();
        inner.core.control.cancel_requested() || !inner.witness.is_current()
    }

    /// Write the post-transport terminal through the pinned writer. On
    /// failure the attempt is conservatively recovered as
    /// `InterruptedUnknown` (an existing terminal is kept).
    pub(crate) fn finish(
        mut self,
        observation: &TerminalObservation,
        body: Option<NewMessageBody>,
    ) -> Result<StoredTerminal, Nir1GenerationRefusal> {
        let inner = self
            .inner
            .take()
            .expect("a transport owner finishes exactly once");
        let result = now_ms()
            .map_err(|_| Nir1StoreFailure::Invalid)
            .and_then(|now| {
                storage::finish_attempt_bounded(
                    &inner.core.workspace,
                    &inner.expected,
                    observation,
                    body,
                    now,
                    &inner.core.pinned_budget(),
                )
                .map_err(|error| error.failure())
            });
        match result {
            Ok(terminal) => Ok(terminal),
            Err(failure) => {
                inner.core.record_failure("finish", failure);
                inner.recover_or_mark_unresolved();
                Err(Nir1GenerationRefusal::Store(failure))
            }
        }
    }
}

impl TransportInner {
    fn recover_or_mark_unresolved(self: Box<Self>) {
        let TransportInner {
            core,
            slot,
            expected,
            ..
        } = *self;
        if let Err(error) = storage::recover_claimed_attempt_bounded(
            &core.workspace,
            &expected,
            &core.pinned_budget(),
        ) {
            core.record_failure("recover", error.failure());
            // The gate stays Open: nothing new is in doubt for the gate, and
            // the next Ready entry's sweep terminalizes the attempt.
            core.mark_unresolved(slot);
        }
    }
}

impl Drop for Nir1TransportOwner {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.take() {
            inner.recover_or_mark_unresolved();
        }
    }
}

/// Synchronization points for tests only.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Nir1OwnerProbePoint {
    BeforePreCommit,
    /// The create's pre-commit checks passed; COMMIT has not started.
    AfterPreCommit,
    AfterCommit,
    BeforeDecision,
    BeforeZeroSend,
}

#[cfg(test)]
pub(crate) mod test_hooks {
    use super::*;
    use grimodex_db::nir1_generation::Nir1GenerationFailpoint;

    type Probe = Box<dyn FnMut() + Send>;

    /// Test-only hooks shared by every state of one owner.
    #[derive(Default)]
    pub(crate) struct Nir1OwnerTestHooks {
        probes: Mutex<Vec<(Nir1OwnerProbePoint, Probe)>>,
        failpoints: Mutex<Vec<(&'static str, Nir1GenerationFailpoint)>>,
        failures: Mutex<Vec<(&'static str, Nir1StoreFailure)>>,
    }

    impl Nir1OwnerTestHooks {
        pub(crate) fn on(&self, point: Nir1OwnerProbePoint, probe: impl FnMut() + Send + 'static) {
            self.probes
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((point, Box::new(probe)));
        }

        /// Arm one failpoint for the next admission writer of `stage`.
        pub(crate) fn fail_next(&self, stage: &'static str, failpoint: Nir1GenerationFailpoint) {
            self.failpoints
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((stage, failpoint));
        }

        pub(crate) fn failures(&self) -> Vec<(&'static str, Nir1StoreFailure)> {
            self.failures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        pub(super) fn fire(&self, point: Nir1OwnerProbePoint) {
            // Run probes without holding the hook mutex.
            let mut probes =
                std::mem::take(&mut *self.probes.lock().unwrap_or_else(PoisonError::into_inner));
            for (probe_point, probe) in probes.iter_mut() {
                if *probe_point == point {
                    probe();
                }
            }
            let mut current = self.probes.lock().unwrap_or_else(PoisonError::into_inner);
            probes.append(&mut current);
            *current = probes;
        }

        pub(super) fn record_failure(&self, stage: &'static str, failure: Nir1StoreFailure) {
            self.failures
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push((stage, failure));
        }

        pub(super) fn decorate_admission(
            &self,
            stage: &'static str,
            budget: Nir1AdmissionSqlBudget,
        ) -> Nir1AdmissionSqlBudget {
            let mut failpoints = self
                .failpoints
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match failpoints.iter().position(|(armed, _)| *armed == stage) {
                Some(index) => budget.with_failpoint(failpoints.remove(index).1),
                None => budget,
            }
        }
    }

    impl Nir1GenerationOwner {
        pub(crate) fn hooks(&self) -> Arc<Nir1OwnerControl> {
            Arc::clone(&self.core.control)
        }
    }

    impl Nir1PreparedAttempt {
        pub(crate) fn hooks(&self) -> Arc<Nir1OwnerControl> {
            Arc::clone(&self.inner().core.control)
        }

        pub(crate) fn expected(&self) -> Nir1ExpectedAttempt {
            self.inner().expected.clone()
        }
    }

    impl Nir1OwnerControl {
        pub(crate) fn test_hooks(&self) -> &Nir1OwnerTestHooks {
            &self.hooks
        }
    }
}

#[cfg(test)]
#[path = "nir1_generation_owner_tests.rs"]
mod tests;
