//! Native-owned profile-wide local-only egress gate (NIR-1 D2a).
//!
//! The Electron main process supplies the caller identity.  This module owns
//! the durable profile state and validates the identity/epoch before a native
//! AI transport is reached.  The state is deliberately a small file beside
//! the existing settings files; it is not part of a workspace database or its
//! migration lifecycle.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::main_grant::ConsumedProfileActivation;

pub const D2A_EGRESS_DENIED_MARKER: &str = "D2A_EGRESS_DENIED:";
/// Prefix of a Native unavailable reason (DR-DA2-8). The code that follows is
/// one of [`ProfileEgressUnavailable::code`]; no path or detail follows it
/// except, for `state-file-unreadable`, the OS error text.
pub const PROFILE_EGRESS_UNAVAILABLE_MARKER: &str = "PROFILE_EGRESS_UNAVAILABLE:";
const STATE_VERSION: u32 = 2;

/// Why this process's profile gate is unavailable (K3/2 "起動時の gate",
/// DR-DA2-8). A closed set; process-local, never persisted and never cleared.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileEgressUnavailable {
    /// The state file could not be read; the Backend is not built.
    StateFileUnreadable,
    /// A persist of the state file failed (startup barrier, stage 4 or 5).
    StateFileUnwritable,
    /// The stop barrier did not drain within its bound (stage 5 or startup).
    BarrierTimeout,
    /// The activation failed for another reason (for example stage 4's
    /// binding no longer held).
    ActivationFailed,
}

impl ProfileEgressUnavailable {
    pub const fn code(self) -> &'static str {
        match self {
            Self::StateFileUnreadable => "state-file-unreadable",
            Self::StateFileUnwritable => "state-file-unwritable",
            Self::BarrierTimeout => "barrier-timeout",
            Self::ActivationFailed => "activation-failed",
        }
    }

    /// The whole N-API error message of this reason.
    pub fn message(self) -> String {
        format!("{PROFILE_EGRESS_UNAVAILABLE_MARKER}{}", self.code())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CallerIdentity {
    pub profile_id: String,
    pub caller_id: String,
    pub caller_epoch: u64,
    pub sender_id: u64,
    pub workspace_id: Option<String>,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEgressStatus {
    pub profile_id: String,
    pub caller_epoch: u64,
    pub restricted: bool,
    pub handles_invalidated: bool,
    pub in_flight_stopped: bool,
    pub sql_policy: grimodex_db::profile_egress_policy::ProfileEgressSqlPolicy,
    /// The Native unavailable reason, when there is one (DR-DA2-8). Absent
    /// otherwise, so a healthy status is unchanged on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<&'static str>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedProfileEgress {
    schema_version: u32,
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    /// Optional keeps schema v1 files readable; v1 had no stop-barrier bits.
    #[serde(default)]
    handles_invalidated: Option<bool>,
    #[serde(default)]
    in_flight_stopped: Option<bool>,
}

#[derive(Debug)]
struct State {
    profile_id: String,
    caller_epoch: u64,
    restricted: bool,
    handles_invalidated: bool,
    in_flight_stopped: bool,
    /// The trusted workspace binding for this process generation. It is
    /// intentionally process-local; workspace open/restore rebinds it before
    /// the corresponding event can issue another caller identity.
    workspace_id: Option<String>,
    /// Exact identities are process-local. A fresh Backend is a fresh process
    /// generation, so stale tuples from a previous process cannot authorize.
    registered_callers: HashMap<u64, CallerIdentity>,
    /// Set by stage 1 (the `ProfileActivation` grant was consumed into a
    /// reservation). `license-control` then uses the restricted client
    /// (DR-DA2-4). Process-local and never cleared.
    activation_reserved: bool,
    /// Process-local, never persisted, never cleared (DR-DA2-8).
    unavailable: Option<ProfileEgressUnavailable>,
}

/// One authority for the profile restriction.  The mutex covers both the
/// state transition and the atomic file replacement so a caller cannot see a
/// persisted epoch that is not the in-memory epoch.
pub struct ProfileEgressState {
    path: PathBuf,
    state: Mutex<State>,
    /// Serializes route-setting writes with the short-lived current-capture
    /// commit boundary; capture admission is non-queuing.
    route_commit_gate: Mutex<()>,
    #[cfg(test)]
    capture_test_events: Mutex<Option<std::sync::mpsc::Sender<CaptureTestEvent>>>,
    #[cfg(test)]
    capture_test_continue: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
    /// Monotonic process-local binding generation. Every workspace bind,
    /// caller invalidation, startup barrier, and registration replacement
    /// revokes permits captured before the transition.
    revocation_generation: Arc<AtomicU64>,
    /// The cancellation of in-flight non-stream legacy provider requests by
    /// the stop barrier (DR-DA2-6).
    legacy_cancel: Arc<LegacyCancel>,
    /// The stop barrier is single-flight: a second run while one is running
    /// is refused (DA-2 ST1 review F3, DR-DA2-21).
    barrier_in_flight: AtomicBool,
}

/// The one running stop barrier. Dropping it (the barrier ended, failed or
/// was dropped at its bound) lets a later barrier start; an unavailable
/// process refuses that later barrier anyway.
pub(crate) struct BarrierFlight<'a>(&'a AtomicBool);

impl Drop for BarrierFlight<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// The stop barrier's cancellation of in-flight non-stream legacy provider
/// requests (K3/2 "activation の途中の AI 処理" 2, DR-DA2-6). Registration is
/// the legacy permit itself: every permit records the generation it was
/// issued in, and [`ProfileDispatchPermit::until_cancelled`] ends its transport
/// future once the barrier advances the generation.
#[derive(Debug, Default)]
struct LegacyCancel {
    generation: AtomicU64,
    notify: Notify,
    /// Transport futures currently waiting inside `until_cancelled`.
    waiting: AtomicUsize,
}

/// A Native dispatch lease. The startup transition closes new leases and
/// invalidates process-local registrations, then waits for every lease to
/// drop before it publishes the final `inFlightStopped` state.
#[cfg(test)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CaptureTestEvent {
    RouteValidated,
    WriterStarting,
    CaptureCommitted,
    RouteUpdateWaiting,
    RouteUpdateAcquired,
}

/// What `ProfileEgressState::admit_publication` observed at the start of a
/// `nir1-publication` or Scope Native entry.
#[derive(Clone, Copy, Debug)]
pub(crate) struct PublicationAdmission {
    restricted: bool,
    revocation_generation: u64,
}

#[derive(Clone, Debug)]
pub struct ProfileDispatchPermit {
    lease: Arc<DispatchLease>,
}

#[derive(Debug)]
struct DispatchLease {
    active_dispatches: Arc<AtomicUsize>,
    dispatch_quiesced: Arc<Notify>,
    admissions_open: Arc<AtomicBool>,
    revocation_generation: Arc<AtomicU64>,
    generation: u64,
    legacy_cancel: Arc<LegacyCancel>,
    legacy_cancel_generation: u64,
}

impl Drop for DispatchLease {
    fn drop(&mut self) {
        if self.active_dispatches.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.dispatch_quiesced.notify_waiters();
        }
    }
}

impl ProfileEgressState {
    pub fn new(path: PathBuf) -> anyhow::Result<Self> {
        // Read bytes, not a string: content that is not UTF-8 is a broken
        // file (row 5), not an unreadable one (row 6; DA-2 ST1 review F6).
        let state = match fs::read(&path) {
            Ok(raw) => match serde_json::from_slice::<PersistedProfileEgress>(&raw) {
                // The acceptance table of the state file (K3/2 "起動時の gate",
                // DR-DA2-8). Every row is decided here and nowhere else.
                Ok(saved)
                    if matches!(saved.schema_version, 1 | STATE_VERSION)
                        && !saved.profile_id.trim().is_empty()
                        && saved.profile_id == saved.profile_id.trim() =>
                {
                    let (handles_invalidated, in_flight_stopped) = if saved.restricted {
                        // Row 2: the v2 form keeps its stop bit. Row 3: schema
                        // v1, a missing bit, or `handlesInvalidated: false`
                        // (never written beside `restricted: true`) is read
                        // as restricted with the stop unconfirmed. Either way
                        // the startup barrier runs again before anything is
                        // published and rewrites the file in the v2 form.
                        let complete = saved.schema_version == STATE_VERSION
                            && saved.handles_invalidated == Some(true);
                        (true, complete && saved.in_flight_stopped == Some(true))
                    } else {
                        // Row 4 (J-1): the product never writes
                        // `restricted: false`, so its content is read as a
                        // missing file would be: the unrestricted bits,
                        // whatever the file says. The file is not rewritten.
                        (false, true)
                    };
                    State::loaded(
                        saved.profile_id,
                        saved.caller_epoch,
                        saved.restricted,
                        handles_invalidated,
                        in_flight_stopped,
                    )
                }
                // Row 5: broken JSON (bytes that are not UTF-8 included), an
                // unknown version or a bad profileId start a fresh restricted
                // profile whose stop is unconfirmed.
                Ok(_) | Err(_) => State::loaded(Uuid::new_v4().to_string(), 1, true, true, false),
            },
            // Row 1: no file is a fresh unrestricted profile.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                State::loaded(Uuid::new_v4().to_string(), 0, false, false, true)
            }
            // Row 6: an unreadable file builds no Backend. The message is the
            // closed reason and the OS error only (P3-9: no path).
            Err(error) => {
                return Err(anyhow::Error::new(error)
                    .context(ProfileEgressUnavailable::StateFileUnreadable.message()))
            }
        };
        let admissions_open = !state.restricted || state.in_flight_stopped;
        Ok(Self {
            path,
            state: Mutex::new(state),
            route_commit_gate: Mutex::new(()),
            #[cfg(test)]
            capture_test_events: Mutex::new(None),
            #[cfg(test)]
            capture_test_continue: Mutex::new(None),
            active_dispatches: Arc::new(AtomicUsize::new(0)),
            dispatch_quiesced: Arc::new(Notify::new()),
            admissions_open: Arc::new(AtomicBool::new(admissions_open)),
            revocation_generation: Arc::new(AtomicU64::new(0)),
            legacy_cancel: Arc::new(LegacyCancel::default()),
            barrier_in_flight: AtomicBool::new(false),
        })
    }

    /// Stage 4 of the activation (K3/2): the one explicit
    /// first-restricted-publication transition. It needs the token of a
    /// consumed `ProfileActivation` grant (stage 1), and the grant's binding
    /// must still hold under this mutex (same profile and caller epoch, still
    /// unrestricted, the disclosure version Native shows); otherwise nothing
    /// changes and the process becomes unavailable (`activation-failed`).
    /// A `cfg(test)` token ([`ConsumedProfileActivation::for_test`]) keeps the
    /// old idempotent behaviour on an already restricted profile.
    pub fn activate_first_restricted_publication(
        &self,
        activation: &ConsumedProfileActivation,
        in_flight_stopped: bool,
    ) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        if !activation.binds(&state.profile_id, state.caller_epoch, state.restricted) {
            state.unavailable = Some(ProfileEgressUnavailable::ActivationFailed);
            return Err(anyhow!(
                "{D2A_EGRESS_DENIED_MARKER} the activation's binding no longer holds"
            ));
        }
        if state.restricted {
            return Ok(status_locked(&state));
        }
        let Some(next_epoch) = state.caller_epoch.checked_add(1) else {
            state.unavailable = Some(ProfileEgressUnavailable::ActivationFailed);
            return Err(anyhow!("caller epoch exhausted"));
        };
        state.caller_epoch = next_epoch;
        state.restricted = true;
        state.handles_invalidated = true;
        state.in_flight_stopped = in_flight_stopped;
        state.registered_callers.clear();
        self.revoke_permits();
        if let Err(error) = self.persist_locked(&state) {
            // A failed durability barrier must never leave the in-memory gate
            // admitting calls merely because the requested stop bit was true.
            // Keep the profile restricted, but fail closed until a later
            // process can establish a fresh startup barrier.
            state.in_flight_stopped = false;
            state.unavailable = Some(ProfileEgressUnavailable::StateFileUnwritable);
            self.admissions_open.store(false, Ordering::Release);
            return Err(error);
        }
        self.admissions_open
            .store(in_flight_stopped, Ordering::Release);
        Ok(status_locked(&state))
    }

    /// Stage 1 marks the reservation here, in the same synchronous call that
    /// consumed the grant (DR-DA2-4).
    pub(crate) fn mark_activation_reserved(&self) {
        self.lock().activation_reserved = true;
    }

    /// `license-control` picks the restricted client once the profile is
    /// restricted or an activation is reserved (K3/2 N-1, DA-1 P3 (b)).
    pub fn license_uses_restricted_client(&self) -> bool {
        let state = self.lock();
        state.restricted || state.activation_reserved
    }

    /// Records why this process is unavailable. The first reason stays.
    pub(crate) fn mark_unavailable(&self, reason: ProfileEgressUnavailable) {
        let mut state = self.lock();
        if state.unavailable.is_none() {
            state.unavailable = Some(reason);
        }
    }

    pub fn unavailable_reason(&self) -> Option<ProfileEgressUnavailable> {
        self.lock().unavailable
    }

    /// Asks every in-flight non-stream legacy provider request to stop
    /// (DR-DA2-6) and returns how many were waiting on their transport inside
    /// [`ProfileDispatchPermit::until_cancelled`] at this moment. A request
    /// whose permit was issued before the request but that had not reached
    /// `until_cancelled` yet is stopped too (`ensure_open` refuses it, and
    /// `until_cancelled` ends at once on the advanced generation), but it is
    /// not in this count (DR-DA2-20, R1). The evidence of the stop is the
    /// drop of each lease, which [`Self::wait_for_dispatches`] observes.
    pub fn cancel_legacy_dispatches(&self) -> usize {
        let waiting = self.legacy_cancel.waiting.load(Ordering::Acquire);
        self.legacy_cancel.generation.fetch_add(1, Ordering::AcqRel);
        self.legacy_cancel.notify.notify_waiters();
        waiting
    }

    /// Starts the single-flight stop barrier (DA-2 ST1 review F3). An
    /// unavailable process refuses it with its reason: recovery is a process
    /// restart only (K3/2). A barrier already running refuses a second one
    /// without making the process unavailable.
    pub(crate) fn begin_barrier_flight(&self) -> anyhow::Result<BarrierFlight<'_>> {
        if let Some(reason) = self.lock().unavailable {
            anyhow::bail!(reason.message());
        }
        anyhow::ensure!(
            self.barrier_in_flight
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "{D2A_EGRESS_DENIED_MARKER} the stop barrier is already running"
        );
        Ok(BarrierFlight(&self.barrier_in_flight))
    }

    /// Whether a stop that was asked for must keep going: the profile is
    /// restricted with its stop unconfirmed (stage 4 to 5, a barrier past its
    /// bound, a failed persist), or the process is unavailable. Runs
    /// `operation` only when it need not, under the profile mutex, so a
    /// barrier cannot start between the check and `operation` (DR-DA2-20, R2).
    pub(crate) fn unless_stop_must_continue(&self, operation: impl FnOnce()) {
        let state = self.lock();
        if state.unavailable.is_some() || (state.restricted && !state.in_flight_stopped) {
            return;
        }
        operation();
    }

    /// Close admissions for one process startup after loading the persisted
    /// profile state. Only an unrestricted profile takes the explicit first
    /// restricted-publication transition; an already restricted profile keeps
    /// its epoch and merely re-runs the stop barrier for this process.
    pub fn begin_startup_barrier(&self) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        anyhow::ensure!(
            state.restricted,
            "{D2A_EGRESS_DENIED_MARKER} profile restriction is not activated"
        );
        state.handles_invalidated = true;
        state.in_flight_stopped = false;
        state.registered_callers.clear();
        self.revoke_permits();
        // Close admissions while holding the same mutex used by begin_dispatch;
        // no caller can pass authorization after this transition starts.
        self.admissions_open.store(false, Ordering::Release);
        if let Err(error) = self.persist_locked(&state) {
            // Row 7 of the acceptance table: admissions stay closed.
            if state.unavailable.is_none() {
                state.unavailable = Some(ProfileEgressUnavailable::StateFileUnwritable);
            }
            return Err(error);
        }
        Ok(status_locked(&state))
    }

    /// Register the exact main-issued identity for this process generation.
    /// The registration is deliberately not durable; only the main process
    /// can create it after the startup stop barrier has completed.
    pub fn register_caller(&self, identity: &CallerIdentity) -> anyhow::Result<()> {
        let mut state = self.lock();
        anyhow::ensure!(
            state.unavailable.is_none(),
            "{D2A_EGRESS_DENIED_MARKER} caller registration is closed while the profile gate is unavailable"
        );
        anyhow::ensure!(
            state.restricted && state.in_flight_stopped,
            "{D2A_EGRESS_DENIED_MARKER} caller registration is closed until startup quiesces"
        );
        authorize_locked(&state, Some(identity))?;
        let replaced = state
            .registered_callers
            .get(&identity.sender_id)
            .is_some_and(|registered| registered != identity);
        state
            .registered_callers
            .insert(identity.sender_id, identity.clone());
        if replaced {
            self.revoke_permits();
        }
        Ok(())
    }

    /// Record the completion of the stop barrier after restriction and epoch
    /// invalidation have already become durable.
    pub fn confirm_in_flight_stopped(&self) -> anyhow::Result<ProfileEgressStatus> {
        let mut state = self.lock();
        anyhow::ensure!(
            state.unavailable.is_none(),
            "{D2A_EGRESS_DENIED_MARKER} the stop cannot be confirmed while the profile gate is unavailable"
        );
        anyhow::ensure!(
            self.active_dispatches.load(Ordering::Acquire) == 0,
            "cannot publish profile egress state while dispatches are active"
        );
        state.in_flight_stopped = true;
        if let Err(error) = self.persist_locked(&state) {
            // Do not expose the completed barrier if its durable marker was not
            // persisted. The next startup must repeat the stop barrier.
            state.in_flight_stopped = false;
            if state.unavailable.is_none() {
                state.unavailable = Some(ProfileEgressUnavailable::StateFileUnwritable);
            }
            self.admissions_open.store(false, Ordering::Release);
            return Err(error);
        }
        self.admissions_open.store(true, Ordering::Release);
        Ok(status_locked(&state))
    }

    pub fn status(&self) -> ProfileEgressStatus {
        status_locked(&self.lock())
    }

    /// Whether the profile is restricted right now. `license-control` selects
    /// its client by [`Self::license_uses_restricted_client`] instead, which
    /// also counts an activation's reservation (DR-DA2-4).
    pub fn is_restricted(&self) -> bool {
        self.lock().restricted
    }

    /// Reserve one legacy Native dispatch while it performs its local work.
    /// The state mutex closes the check/increment race with the startup
    /// transition: after restriction, only the current main-issued epoch can
    /// obtain a lease.
    pub fn begin_dispatch(
        &self,
        identity: Option<&CallerIdentity>,
    ) -> anyhow::Result<ProfileDispatchPermit> {
        let state = self.lock();
        self.begin_dispatch_locked(&state, identity)
    }

    /// Reserve a lease for a legacy provider-egress Native entry (the eight
    /// pre-D2a AI entries: post-effect runs, chat send/stream, inline stream,
    /// agent send, model listing, connection test). These entries send the
    /// manuscript or credentials to a remote provider and have no
    /// D2a-eligible route, so a restricted profile denies them outright,
    /// even for a registered, quiesced caller (K3/2 G-2). The check and the
    /// lease increment happen under the same state mutex as the first
    /// restricted-publication transition, so no permit can be issued after
    /// the profile becomes restricted. Unrestricted behaviour is unchanged.
    pub fn begin_legacy_provider_dispatch(
        &self,
        identity: Option<&CallerIdentity>,
    ) -> anyhow::Result<ProfileDispatchPermit> {
        let state = self.lock();
        anyhow::ensure!(
            !state.restricted,
            "{D2A_EGRESS_DENIED_MARKER} provider egress is closed while the profile is restricted"
        );
        // An activation that failed at stage 4 can leave the profile
        // unrestricted but unavailable; provider egress stays closed
        // (DA-2 ST1 review F3).
        anyhow::ensure!(
            state.unavailable.is_none(),
            "{D2A_EGRESS_DENIED_MARKER} provider egress is closed while the profile gate is unavailable"
        );
        self.begin_dispatch_locked(&state, identity)
    }

    fn begin_dispatch_locked(
        &self,
        state: &State,
        identity: Option<&CallerIdentity>,
    ) -> anyhow::Result<ProfileDispatchPermit> {
        if state.restricted {
            authorize_locked(state, identity)?;
            anyhow::ensure!(
                state.in_flight_stopped,
                "{D2A_EGRESS_DENIED_MARKER} dispatch admissions are closed during startup quiescence"
            );
            let identity = identity
                .ok_or_else(|| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is missing"))?;
            anyhow::ensure!(
                state
                    .registered_callers
                    .get(&identity.sender_id)
                    .is_some_and(|registered| registered == identity),
                "{D2A_EGRESS_DENIED_MARKER} caller identity is not registered in this process"
            );
        }
        self.active_dispatches.fetch_add(1, Ordering::AcqRel);
        let generation = self.revocation_generation.load(Ordering::Acquire);
        Ok(ProfileDispatchPermit {
            lease: Arc::new(DispatchLease {
                active_dispatches: Arc::clone(&self.active_dispatches),
                dispatch_quiesced: Arc::clone(&self.dispatch_quiesced),
                admissions_open: Arc::clone(&self.admissions_open),
                revocation_generation: Arc::clone(&self.revocation_generation),
                generation,
                legacy_cancel: Arc::clone(&self.legacy_cancel),
                legacy_cancel_generation: self.legacy_cancel.generation.load(Ordering::Acquire),
            }),
        })
    }

    /// Invalidate every process-local registration when the trusted workspace
    /// binding changes. Old tuples must not remain usable until each sender
    /// happens to make a new invoke.
    /// Test only: drop one sender's registration without revoking dispatch
    /// permits, so a test can tell a Native stop from the permit's own stop.
    #[cfg(test)]
    pub(crate) fn forget_caller_for_test(&self, sender_id: u64) {
        self.lock().registered_callers.remove(&sender_id);
    }

    pub fn invalidate_callers(&self) {
        let mut state = self.lock();
        state.registered_callers.clear();
        self.revoke_permits();
    }

    /// Rebind the trusted active workspace and invalidate all caller tuples.
    /// Main supplies the same path that Native publishes in its
    /// `workspace:opened` event, so an event-order race cannot re-register a
    /// tuple from the previous workspace.
    pub fn bind_workspace(&self, workspace_id: Option<String>) {
        let mut state = self.lock();
        state.workspace_id = workspace_id;
        state.registered_callers.clear();
        self.revoke_permits();
    }

    /// Bind a restore-only workspace before the corresponding `workspace:opened`
    /// event is emitted. Safe Mode has no active Database authority, but its
    /// recovery commands still need the same trusted workspace tuple as main;
    /// keeping this transition explicit prevents the restore-only early return
    /// from silently skipping the Native binding update.
    pub fn bind_recovery_workspace(&self, workspace_id: Option<String>) {
        self.bind_workspace(workspace_id);
    }

    /// How many non-stream legacy transports are waiting inside
    /// `until_cancelled` (a synchronisation point for tests).
    #[cfg(test)]
    pub(crate) fn legacy_waiting_for_test(&self) -> usize {
        self.legacy_cancel.waiting.load(Ordering::Acquire)
    }

    /// Wait until all leases acquired before the transition have dropped.
    pub async fn wait_for_dispatches(&self) {
        loop {
            if self.active_dispatches.load(Ordering::Acquire) == 0 {
                return;
            }
            let notified = self.dispatch_quiesced.notified();
            if self.active_dispatches.load(Ordering::Acquire) == 0 {
                return;
            }
            notified.await;
        }
    }

    /// Validate an identity bound by Electron main. Renderer IPC always
    /// supplies it because `registerIpcRouter` injects it at the sender
    /// boundary. Before D2a startup (standalone compatibility tests) the
    /// profile remains unrestricted and legacy direct calls continue to work.
    #[cfg(test)]
    pub fn authorize_optional(&self, identity: Option<&CallerIdentity>) -> anyhow::Result<()> {
        let state = self.lock();
        authorize_locked(&state, identity)
    }

    /// Revalidate a DB dispatch against the one pinned workspace authority.
    /// The check is intentionally performed under the same state mutex as
    /// bind/invalidate/registration transitions, so a swap cannot publish a
    /// result after the caller tuple has been revoked.
    pub fn reauthorize_dispatch(
        &self,
        permit: &ProfileDispatchPermit,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.with_authorized_dispatch(permit, identity, pinned_workspace_id, || Ok(()))
    }

    /// Serialize a short final dispatch claim with profile/caller revocation.
    /// The caller already owns its DB transaction; its closure must include
    /// COMMIT, must not reacquire this state, and must never await transport.
    /// This is not a product transport grant: the route, workspace, current
    /// material and durable one-shot claim remain the caller's responsibility.
    pub fn with_authorized_dispatch<T>(
        &self,
        permit: &ProfileDispatchPermit,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let state = self.lock();
        permit.ensure_open()?;
        anyhow::ensure!(
            Arc::ptr_eq(
                &permit.lease.revocation_generation,
                &self.revocation_generation
            ) && permit.lease.generation == self.revocation_generation.load(Ordering::Acquire),
            "{D2A_EGRESS_DENIED_MARKER} dispatch binding was revoked"
        );
        if state.restricted {
            authorize_locked(&state, identity)?;
            let identity = identity
                .ok_or_else(|| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is missing"))?;
            anyhow::ensure!(
                identity.workspace_id.as_deref() == pinned_workspace_id,
                "{D2A_EGRESS_DENIED_MARKER} pinned workspace does not match caller identity"
            );
            anyhow::ensure!(
                state
                    .registered_callers
                    .get(&identity.sender_id)
                    .is_some_and(|registered| registered == identity),
                "{D2A_EGRESS_DENIED_MARKER} caller identity is no longer registered"
            );
        }
        operation()
    }

    /// Check current Native caller/profile authority without granting a
    /// dispatch lease. Preparation may read profile-owned route state here,
    /// but must release this lock before SQLite or payload rendering.
    pub(crate) fn with_authorized_preparation<T>(
        &self,
        identity: &CallerIdentity,
        pinned_workspace_id: &str,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let state = self.lock();
        anyhow::ensure!(
            state.restricted && state.in_flight_stopped,
            "{D2A_EGRESS_DENIED_MARKER} profile preparation is not admitted"
        );
        authorize_locked(&state, Some(identity))?;
        anyhow::ensure!(
            identity.workspace_id.as_deref() == Some(pinned_workspace_id)
                && state.workspace_id.as_deref() == Some(pinned_workspace_id),
            "{D2A_EGRESS_DENIED_MARKER} preparation workspace does not match the active caller"
        );
        anyhow::ensure!(
            state
                .registered_callers
                .get(&identity.sender_id)
                .is_some_and(|registered| registered == identity),
            "{D2A_EGRESS_DENIED_MARKER} preparation caller is not registered in this process"
        );
        operation()
    }

    /// Start-time admission for a `nir1-publication` or Scope Native entry
    /// (K3/2 "区分の意味"). It grants no dispatch lease: Related Scenes can wait
    /// for minutes and must not hold up the activation drain, so the result is
    /// protected by a second check at return (`recheck_publication`) instead.
    /// An unrestricted profile admits every call unchecked (and remembers
    /// that, so a restriction that begins meanwhile still discards the
    /// result). A restricted one needs the stop barrier to be confirmed and
    /// the exact registered main-issued identity of the pinned workspace.
    pub(crate) fn admit_publication(
        &self,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
    ) -> anyhow::Result<PublicationAdmission> {
        let state = self.lock();
        if state.restricted {
            publication_authorized_locked(&state, identity, pinned_workspace_id)?;
        }
        Ok(PublicationAdmission {
            restricted: state.restricted,
            revocation_generation: self.revocation_generation.load(Ordering::Acquire),
        })
    }

    /// Return-time recheck of an `admit_publication` admission. Fails closed
    /// when the profile became restricted after an unrestricted admission, or
    /// when the caller registration, epoch, workspace or revocation
    /// generation changed since a restricted admission. The caller discards
    /// its result on error.
    pub(crate) fn recheck_publication(
        &self,
        admission: PublicationAdmission,
        identity: Option<&CallerIdentity>,
        pinned_workspace_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let state = self.lock();
        if !admission.restricted {
            anyhow::ensure!(
                !state.restricted,
                "{D2A_EGRESS_DENIED_MARKER} publication completed after profile restriction began"
            );
            return Ok(());
        }
        anyhow::ensure!(
            state.restricted
                && admission.revocation_generation
                    == self.revocation_generation.load(Ordering::Acquire),
            "{D2A_EGRESS_DENIED_MARKER} publication binding was revoked"
        );
        publication_authorized_locked(&state, identity, pinned_workspace_id)
    }

    /// Admit one current capture without queueing behind another capture or
    /// settings write. Its closure may use SQLite but must not retain `state`.
    pub(crate) fn with_route_capture_commit<T>(
        &self,
        operation: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let _route = match self.route_commit_gate.try_lock() {
            Ok(route) => route,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => {
                anyhow::bail!("NIR1_CHAT_CAPTURE_ROUTE_BUSY")
            }
        };
        operation()
    }

    pub(crate) fn revocation_generation(&self) -> u64 {
        self.revocation_generation.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn set_capture_test_hooks(
        &self,
        events: std::sync::mpsc::Sender<CaptureTestEvent>,
        continuation: std::sync::mpsc::Receiver<()>,
    ) {
        *self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(events);
        *self
            .capture_test_continue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(continuation);
    }

    #[cfg(test)]
    pub(crate) fn capture_route_validated_for_test(&self) -> anyhow::Result<()> {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(CaptureTestEvent::RouteValidated);
        }
        if let Some(receiver) = self
            .capture_test_continue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            receiver
                .recv()
                .map_err(|_| anyhow!("capture test continuation closed"))?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn capture_writer_starting_for_test(&self) {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(CaptureTestEvent::WriterStarting);
        }
    }

    #[cfg(test)]
    pub(crate) fn capture_committed_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::CaptureCommitted);
    }

    #[cfg(test)]
    fn route_update_waiting_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::RouteUpdateWaiting);
    }

    #[cfg(test)]
    fn route_update_acquired_for_test(&self) {
        self.send_capture_test_event(CaptureTestEvent::RouteUpdateAcquired);
    }

    #[cfg(test)]
    fn send_capture_test_event(&self, event: CaptureTestEvent) {
        if let Some(sender) = self
            .capture_test_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
        {
            let _ = sender.send(event);
        }
    }

    /// Route-setting writes serialize behind a currently admitted capture.
    /// Revoke before writing, including failed/partial file writes. The
    /// closure performs filesystem work only and never enters DB/core.
    pub fn with_route_update<T>(
        &self,
        update: impl FnOnce() -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        #[cfg(test)]
        self.route_update_waiting_for_test();
        let _route = self
            .route_commit_gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        #[cfg(test)]
        self.route_update_acquired_for_test();
        let _state = self.lock();
        self.revoke_permits();
        update()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn revoke_permits(&self) {
        self.revocation_generation.fetch_add(1, Ordering::AcqRel);
    }

    fn persist_locked(&self, state: &State) -> anyhow::Result<()> {
        self.persist_locked_with(
            state,
            |staged, destination| {
                grimodex_db::fs_replace::retry_replace(|| {
                    grimodex_db::backup_restore::atomic_replace(staged, destination)
                })
                .map_err(anyhow::Error::from)
            },
            sync_parent_directory,
        )
    }

    fn persist_locked_with<Replace, SyncDirectory>(
        &self,
        state: &State,
        replace: Replace,
        sync_directory: SyncDirectory,
    ) -> anyhow::Result<()>
    where
        Replace: FnOnce(&Path, &Path) -> anyhow::Result<()>,
        SyncDirectory: FnOnce(&Path) -> anyhow::Result<()>,
    {
        let saved = PersistedProfileEgress {
            schema_version: STATE_VERSION,
            profile_id: state.profile_id.clone(),
            caller_epoch: state.caller_epoch,
            restricted: state.restricted,
            handles_invalidated: Some(state.handles_invalidated),
            in_flight_stopped: Some(state.in_flight_stopped),
        };
        let raw = serde_json::to_vec_pretty(&saved)?;
        let parent = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        let mut temporary_os = self.path.as_os_str().to_owned();
        temporary_os.push(format!(".tmp-{}", Uuid::new_v4()));
        let temporary = PathBuf::from(temporary_os);
        let result = (|| -> anyhow::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .with_context(|| format!("create {}", temporary.display()))?;
            file.write_all(&raw)
                .with_context(|| format!("write {}", temporary.display()))?;
            file.sync_all()
                .with_context(|| format!("sync {}", temporary.display()))?;
            drop(file);
            replace(&temporary, &self.path)
                .with_context(|| format!("replace {}", self.path.display()))?;
            sync_directory(parent)
                .with_context(|| format!("sync directory {}", parent.display()))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> anyhow::Result<()> {
    // `Path::parent()` for a relative filename is an empty path.  The
    // profile path is normally absolute, but syncing `.` keeps the durability
    // contract intact for tests and direct embedders as well.
    let directory = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    File::open(directory)
        .with_context(|| format!("open directory {}", directory.display()))?
        .sync_all()
        .with_context(|| format!("sync directory {}", directory.display()))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> anyhow::Result<()> {
    Ok(())
}

impl ProfileDispatchPermit {
    /// Recheck the startup admission immediately before a real transport call.
    /// A permit keeps the dispatch counted until its owner returns, allowing
    /// the startup barrier to drain a call that was already in flight.
    pub fn ensure_open(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.lease.admissions_open.load(Ordering::Acquire),
            "{D2A_EGRESS_DENIED_MARKER} dispatch admissions are closed"
        );
        anyhow::ensure!(
            self.lease.revocation_generation.load(Ordering::Acquire) == self.lease.generation,
            "{D2A_EGRESS_DENIED_MARKER} dispatch binding was revoked"
        );
        Ok(())
    }

    /// Runs a non-stream legacy provider transport until it completes or the
    /// stop barrier cancels it (DR-DA2-6). A cancelled transport future is
    /// dropped here; the caller then returns and drops the permit, which is
    /// the evidence the barrier waits for.
    pub async fn until_cancelled<T>(
        &self,
        transport: impl Future<Output = T>,
    ) -> anyhow::Result<T> {
        let cancel = &self.lease.legacy_cancel;
        cancel.waiting.fetch_add(1, Ordering::AcqRel);
        let _waiting = WaitingGuard(cancel);
        tokio::select! {
            biased;
            () = self.cancelled() => Err(anyhow!(
                "{D2A_EGRESS_DENIED_MARKER} legacy-request-stopped: the provider request was stopped by the profile restriction"
            )),
            output = transport => Ok(output),
        }
    }

    async fn cancelled(&self) {
        let cancel = &self.lease.legacy_cancel;
        loop {
            let notified = cancel.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if cancel.generation.load(Ordering::Acquire) != self.lease.legacy_cancel_generation {
                return;
            }
            notified.await;
        }
    }
}

struct WaitingGuard<'a>(&'a LegacyCancel);

impl Drop for WaitingGuard<'_> {
    fn drop(&mut self) {
        self.0.waiting.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The restricted conditions of a publication entry: the stop barrier is
/// confirmed, the identity is the exact registered main-issued tuple, and it
/// names the pinned workspace. Messages carry no owner, ticket or identity.
fn publication_authorized_locked(
    state: &State,
    identity: Option<&CallerIdentity>,
    pinned_workspace_id: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        state.in_flight_stopped,
        "{D2A_EGRESS_DENIED_MARKER} publication is closed during startup quiescence"
    );
    authorize_locked(state, identity)?;
    let identity =
        identity.ok_or_else(|| anyhow!("{D2A_EGRESS_DENIED_MARKER} caller identity is missing"))?;
    anyhow::ensure!(
        pinned_workspace_id.is_some() && identity.workspace_id.as_deref() == pinned_workspace_id,
        "{D2A_EGRESS_DENIED_MARKER} pinned workspace does not match caller identity"
    );
    anyhow::ensure!(
        state
            .registered_callers
            .get(&identity.sender_id)
            .is_some_and(|registered| registered == identity),
        "{D2A_EGRESS_DENIED_MARKER} caller identity is not registered in this process"
    );
    Ok(())
}

fn authorize_locked(state: &State, identity: Option<&CallerIdentity>) -> anyhow::Result<()> {
    if !state.restricted {
        return Ok(());
    }
    let Some(identity) = identity else {
        return Err(anyhow!(
            "{D2A_EGRESS_DENIED_MARKER} caller identity is missing"
        ));
    };
    if identity.profile_id != state.profile_id
        || identity.caller_epoch != state.caller_epoch
        || identity.workspace_id != state.workspace_id
        || identity.sender_id == 0
        || identity.caller_id.trim().is_empty()
        || identity.caller_id != identity.caller_id.trim()
        || identity.session_id.trim().is_empty()
        || identity.session_id != identity.session_id.trim()
        || identity
            .workspace_id
            .as_deref()
            .is_some_and(|workspace| workspace.trim().is_empty() || workspace != workspace.trim())
    {
        return Err(anyhow!(
            "{D2A_EGRESS_DENIED_MARKER} caller identity is stale or not bound to this profile"
        ));
    }
    Ok(())
}

fn status_locked(state: &State) -> ProfileEgressStatus {
    ProfileEgressStatus {
        profile_id: state.profile_id.clone(),
        caller_epoch: state.caller_epoch,
        restricted: state.restricted,
        handles_invalidated: state.handles_invalidated,
        in_flight_stopped: state.in_flight_stopped,
        sql_policy: grimodex_db::profile_egress_policy::sql_policy_for_status(),
        unavailable_reason: state.unavailable.map(ProfileEgressUnavailable::code),
    }
}

impl State {
    fn loaded(
        profile_id: String,
        caller_epoch: u64,
        restricted: bool,
        handles_invalidated: bool,
        in_flight_stopped: bool,
    ) -> Self {
        Self {
            profile_id,
            caller_epoch,
            restricted,
            handles_invalidated,
            in_flight_stopped,
            workspace_id: None,
            registered_callers: HashMap::new(),
            activation_reserved: false,
            unavailable: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grimodex-d2a-{label}-{}.json", Uuid::new_v4()))
    }

    fn publication_identity(
        status: &ProfileEgressStatus,
        sender_id: u64,
        workspace: &str,
    ) -> CallerIdentity {
        CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: format!("main-issued-{sender_id}"),
            caller_epoch: status.caller_epoch,
            sender_id,
            workspace_id: Some(workspace.to_string()),
            session_id: "session-a".to_string(),
        }
    }

    #[test]
    fn publication_admission_is_unchecked_while_unrestricted_but_discards_after_restriction() {
        let path = temp_path("publication-unrestricted");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let admission = state
            .admit_publication(None, None)
            .expect("unrestricted admits without an identity");
        state
            .recheck_publication(admission, None, None)
            .expect("unrestricted recheck passes");
        // A restriction that begins while the call is in flight discards it:
        // the admission was unchecked, so nothing proves the caller.
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        assert!(state
            .recheck_publication(admission, None, None)
            .expect_err("restriction began meanwhile")
            .to_string()
            .contains("publication completed after profile restriction began"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restricted_publication_admission_needs_the_exact_registered_identity() {
        let path = temp_path("publication-restricted");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = publication_identity(&status, 61, "workspace-a");
        // Not registered yet.
        assert!(state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .is_err());
        state.register_caller(&identity).expect("register");
        state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect("registered caller of the pinned workspace");
        // Missing, other-sender, stale-epoch and other-workspace identities.
        assert!(state
            .admit_publication(None, Some("workspace-a"))
            .expect_err("missing")
            .to_string()
            .contains("caller identity is missing"));
        let other_sender = publication_identity(&status, 62, "workspace-a");
        assert!(state
            .admit_publication(Some(&other_sender), Some("workspace-a"))
            .is_err());
        let mut tampered = identity.clone();
        tampered.session_id = "forged-session".to_string();
        assert!(state
            .admit_publication(Some(&tampered), Some("workspace-a"))
            .is_err());
        let mut stale = identity.clone();
        stale.caller_epoch += 1;
        assert!(state
            .admit_publication(Some(&stale), Some("workspace-a"))
            .is_err());
        assert!(state
            .admit_publication(Some(&identity), Some("workspace-b"))
            .is_err());
        assert!(state.admit_publication(Some(&identity), None).is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restricted_publication_is_closed_until_the_stop_barrier_confirms() {
        let path = temp_path("publication-quiescing");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("activate with the barrier still pending");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = publication_identity(&status, 63, "workspace-a");
        assert!(state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect_err("registration and publication are closed")
            .to_string()
            .contains("closed during startup quiescence"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restricted_publication_recheck_rejects_every_revocation() {
        let path = temp_path("publication-recheck");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = publication_identity(&status, 64, "workspace-a");
        state.register_caller(&identity).expect("register");

        let admission = state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect("admitted");
        state
            .recheck_publication(admission, Some(&identity), Some("workspace-a"))
            .expect("nothing changed");

        // Caller invalidation (workspace swap, activation of a new epoch).
        state.invalidate_callers();
        assert!(state
            .recheck_publication(admission, Some(&identity), Some("workspace-a"))
            .is_err());

        // Same-path workspace rebind (Restore) also revokes.
        state.register_caller(&identity).expect("register again");
        let admission = state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect("admitted again");
        state.bind_workspace(Some("workspace-a".to_string()));
        assert!(state
            .recheck_publication(admission, Some(&identity), Some("workspace-a"))
            .is_err());

        // A route-setting write bumps the revocation generation too.
        state
            .register_caller(&identity)
            .expect("register once more");
        let admission = state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect("admitted once more");
        state.with_route_update(|| Ok(())).expect("route update");
        assert!(state
            .recheck_publication(admission, Some(&identity), Some("workspace-a"))
            .is_err());

        // The workspace named by the identity must still be the pinned one.
        state
            .register_caller(&identity)
            .expect("final registration");
        let admission = state
            .admit_publication(Some(&identity), Some("workspace-a"))
            .expect("final admission");
        assert!(state
            .recheck_publication(admission, Some(&identity), Some("workspace-b"))
            .is_err());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn final_dispatch_guard_holds_profile_authority_through_claim() {
        let path = temp_path("final-dispatch-guard");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".into()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".into(),
            caller_epoch: status.caller_epoch,
            sender_id: 51,
            workspace_id: Some("workspace-a".into()),
            session_id: "session-a".into(),
        };
        state.register_caller(&identity).expect("register");
        let permit = state.begin_dispatch(Some(&identity)).expect("permit");
        let result = state
            .with_authorized_dispatch(&permit, Some(&identity), Some("workspace-a"), || {
                assert!(matches!(
                    state.state.try_lock(),
                    Err(std::sync::TryLockError::WouldBlock)
                ));
                Ok("durable-claim")
            })
            .expect("claim under guard");
        assert_eq!(result, "durable-claim");
        assert!(
            state.state.try_lock().is_ok(),
            "transport must run after guard release"
        );
        state.invalidate_callers();
        let entered = AtomicBool::new(false);
        assert!(state
            .with_authorized_dispatch(&permit, Some(&identity), Some("workspace-a"), || {
                entered.store(true, Ordering::SeqCst);
                Ok(())
            })
            .is_err());
        assert!(!entered.load(Ordering::SeqCst));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn route_update_serializes_with_final_claim_and_revokes_on_failure() {
        let path = temp_path("route-update-guard");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let permit = state.begin_dispatch(None).expect("legacy fixture permit");
        let result: anyhow::Result<()> = state.with_route_update(|| {
            assert!(matches!(
                state.state.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            assert!(
                permit.ensure_open().is_err(),
                "revoke before file writer enters"
            );
            Err(anyhow!("partial route write"))
        });
        assert!(result.is_err());
        assert!(state
            .with_authorized_dispatch(&permit, None, None, || Ok(()))
            .is_err());
        assert!(state.state.try_lock().is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn final_dispatch_guard_rejects_permit_from_another_profile_owner() {
        let first = ProfileEgressState::new(temp_path("permit-owner-a")).expect("first");
        let second = ProfileEgressState::new(temp_path("permit-owner-b")).expect("second");
        let permit = first.begin_dispatch(None).expect("first owner permit");
        assert!(second
            .with_authorized_dispatch(&permit, None, None, || Ok(()))
            .is_err());
    }

    #[test]
    fn activation_persists_profile_and_rotates_epoch() {
        let path = temp_path("persist");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let before = state.status();
        let activated = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        assert!(activated.restricted);
        assert!(activated.handles_invalidated);
        assert!(activated.in_flight_stopped);
        assert!(activated.caller_epoch > before.caller_epoch);

        let reloaded = ProfileEgressState::new(path.clone()).expect("reload");
        let restored = reloaded.status();
        assert_eq!(restored.profile_id, activated.profile_id);
        assert_eq!(restored.caller_epoch, activated.caller_epoch);
        assert!(restored.restricted);
        assert!(restored.handles_invalidated);
        assert!(restored.in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn directory_sync_failure_after_replace_is_not_reported_as_persist_success() {
        let path = temp_path("directory-sync-failure");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let locked = state.lock();
        let result = state.persist_locked_with(
            &locked,
            |staged, destination| fs::rename(staged, destination).map_err(anyhow::Error::from),
            |_parent| Err(anyhow!("injected directory sync failure")),
        );
        drop(locked);

        let error = result.expect_err("directory sync failure must fail persistence");
        assert!(
            format!("{error:#}").contains("injected directory sync failure"),
            "unexpected persistence error: {error:#}"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn activation_stays_closed_when_profile_persistence_fails() {
        let parent = temp_path("persistence-failure-parent");
        let path = parent.join("profile-egress.json");
        let state = ProfileEgressState::new(path).expect("state before parent exists");
        fs::write(&parent, b"blocking file").expect("create blocking parent file");

        let error = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect_err("activation must fail when its profile path cannot be persisted");
        assert!(format!("{error:#}").contains("create"));
        let status = state.status();
        assert!(status.restricted);
        assert!(!status.in_flight_stopped);
        assert!(
            state.begin_dispatch(None).is_err(),
            "failed persistence must not leave admissions open"
        );
        let _ = fs::remove_file(parent);
    }

    #[test]
    fn status_publishes_the_native_sql_policy_without_a_second_inventory() {
        let path = temp_path("policy-status");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state.status();
        let policy = grimodex_db::profile_egress_policy::sql_policy_for_status();
        assert_eq!(status.sql_policy.version, policy.version);
        assert_eq!(status.sql_policy.version, 2);
        assert_eq!(status.sql_policy.closed_tables, policy.closed_tables);
        assert_eq!(status.sql_policy.read_open_tables, policy.read_open_tables);
        assert_eq!(
            status.sql_policy.read_open_columns,
            policy.read_open_columns
        );
        let json = serde_json::to_value(status).expect("status JSON");
        assert_eq!(json["sqlPolicy"]["version"], policy.version);
        assert!(json["sqlPolicy"]["closedTables"].is_array());
        assert!(json["sqlPolicy"]["readOpenTables"].is_array());
        assert!(json["sqlPolicy"]["readOpenColumns"].is_array());
        assert!(json["sqlPolicy"].get("protectedTables").is_none());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn repeated_startup_does_not_rotate_restricted_profile_epoch() {
        let path = temp_path("idempotent");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let first = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("first transition");
        let second = state.begin_startup_barrier().expect("restart transition");
        assert_eq!(second.profile_id, first.profile_id);
        assert_eq!(second.caller_epoch, first.caller_epoch);
        assert!(!second.in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    /// K3/2 Negative (10): there is no operation that releases the restriction.
    /// Every state-changing operation of the writer, run on a restricted
    /// profile, leaves the durable file `restricted: true` (and a reload
    /// restricted), and the source holds a single assignment to the flag.
    #[test]
    fn no_operation_of_the_writer_releases_the_restriction() {
        let path = temp_path("one-way");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        let status = state.status();
        state.bind_workspace(Some("workspace-a".into()));
        state.bind_recovery_workspace(None);
        state.invalidate_callers();
        state.begin_startup_barrier().expect("restart barrier");
        state.confirm_in_flight_stopped().expect("confirm");
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("repeat activation is idempotent");
        // DA-2's operations (stage 1's mark, the unavailable reason, the
        // barrier's cancellation) and a real stage-4 token on a restricted
        // profile (refused) do not release it either.
        state.mark_activation_reserved();
        state.mark_unavailable(ProfileEgressUnavailable::BarrierTimeout);
        state.cancel_legacy_dispatches();
        let real = crate::main_grant::ConsumedProfileActivation::bound_for_test(
            crate::main_grant::ProfileActivationGrantPayload {
                profile_id: status.profile_id.clone(),
                caller_epoch: status.caller_epoch,
                disclosure_version:
                    crate::profile_activation::PROFILE_ACTIVATION_DISCLOSURE_VERSION,
                disclosure_digest: String::new(),
            },
        );
        assert!(state
            .activate_first_restricted_publication(&real, false)
            .is_err());
        let on_disk: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("state file")).expect("json");
        assert_eq!(on_disk["restricted"], serde_json::Value::Bool(true));
        assert!(state.is_restricted());
        let reloaded = ProfileEgressState::new(path.clone()).expect("reload");
        assert!(reloaded.is_restricted());
        assert_eq!(reloaded.status().profile_id, status.profile_id);

        // The only assignment to the flag in the module (outside its tests)
        // is the one-way `= true`; nothing writes `restricted: false` or
        // removes the file.
        let source = include_str!("profile_egress.rs");
        let production = source
            .split("#[cfg(test)]\nmod tests")
            .next()
            .expect("production source");
        let assignments: Vec<&str> = production
            .lines()
            .filter(|line| line.trim_start().starts_with("state.restricted ="))
            .collect();
        assert_eq!(assignments.len(), 1, "{assignments:?}");
        assert!(assignments[0].contains("= true;"), "{assignments:?}");
        // The only removal is the temporary file of an atomic replace.
        for line in production.lines().filter(|line| line.contains("remove_")) {
            assert!(
                line.contains("remove_file(&temporary)"),
                "unexpected removal in profile_egress.rs: {line}"
            );
        }
        assert!(!production.contains("restricted = false"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_barrier_requires_the_explicit_first_publication() {
        let path = temp_path("explicit-activation");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        assert!(state.begin_startup_barrier().is_err());
        assert!(!state.status().restricted);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn partial_stop_reloads_restricted_until_a_new_barrier_confirms() {
        let path = temp_path("partial-stop");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let first = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("first transition");
        drop(state);

        let recovered = ProfileEgressState::new(path.clone()).expect("reload");
        let pending = recovered.status();
        assert_eq!(pending.profile_id, first.profile_id);
        assert_eq!(pending.caller_epoch, first.caller_epoch);
        assert!(pending.restricted);
        assert!(pending.handles_invalidated);
        assert!(!pending.in_flight_stopped);
        assert!(recovered.begin_dispatch(None).is_err());
        recovered
            .confirm_in_flight_stopped()
            .expect("recovery barrier");
        assert!(recovered.status().in_flight_stopped);
        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn dispatch_barrier_waits_for_active_permit_and_rejects_new_epoch() {
        let path = temp_path("barrier");
        let state = std::sync::Arc::new(ProfileEgressState::new(path.clone()).expect("state"));
        let active = state.begin_dispatch(None).expect("unrestricted permit");
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("activate");
        assert!(state.confirm_in_flight_stopped().is_err());

        let profile = state.status();
        let identity = CallerIdentity {
            profile_id: profile.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: profile.caller_epoch,
            sender_id: 7,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        let next = state.begin_dispatch(Some(&identity));
        assert!(
            next.is_err(),
            "admissions must stay closed until the active permit drains"
        );
        assert!(
            state.register_caller(&identity).is_err(),
            "caller registration must remain closed during the barrier"
        );

        let wait_state = std::sync::Arc::clone(&state);
        let wait = tokio::spawn(async move { wait_state.wait_for_dispatches().await });
        tokio::task::yield_now().await;
        assert!(
            !wait.is_finished(),
            "barrier must wait while leases are held"
        );
        drop(active);
        wait.await.expect("barrier wait");
        let confirmed = state
            .confirm_in_flight_stopped()
            .expect("barrier confirmation");
        assert!(confirmed.in_flight_stopped);
        state
            .register_caller(&identity)
            .expect("registration opens after the barrier");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("registered caller after the barrier");
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn stale_or_forged_identity_is_denied_after_activation() {
        let path = temp_path("identity");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        let valid = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 7,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        state
            .authorize_optional(Some(&valid))
            .expect("valid identity");
        let mut stale = valid.clone();
        stale.caller_epoch -= 1;
        let error = state
            .authorize_optional(Some(&stale))
            .expect_err("stale identity");
        assert!(error.to_string().starts_with(D2A_EGRESS_DENIED_MARKER));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn registration_requires_exact_current_process_identity() {
        let path = temp_path("registration");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("activate");
        state.confirm_in_flight_stopped().expect("startup barrier");
        state.bind_workspace(Some("workspace-1".to_string()));
        let valid = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 7,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-1".to_string(),
        };
        state
            .register_caller(&valid)
            .expect("register valid caller");
        let permit = state
            .begin_dispatch(Some(&valid))
            .expect("registered caller");
        drop(permit);

        let mut forged = valid.clone();
        forged.session_id = "session-forged".to_string();
        assert!(
            state.begin_dispatch(Some(&forged)).is_err(),
            "same structural profile/epoch must not authorize a forged tuple"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn replacing_sender_registration_invalidates_previous_tuple() {
        let path = temp_path("registration-replace");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-1".to_string()));
        let first = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-first".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 9,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-first".to_string(),
        };
        state
            .register_caller(&first)
            .expect("register first caller");
        let mut replacement = first.clone();
        replacement.caller_id = "main-second".to_string();
        replacement.workspace_id = Some("workspace-1".to_string());
        replacement.session_id = "session-second".to_string();
        state
            .register_caller(&replacement)
            .expect("register replacement caller");
        assert!(state.begin_dispatch(Some(&first)).is_err());
        let permit = state
            .begin_dispatch(Some(&replacement))
            .expect("replacement caller");
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restore_only_workspace_binding_reauthorizes_recovery_then_requires_rebind() {
        let path = temp_path("recovery-binding");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity_a = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued-a".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 33,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state
            .register_caller(&identity_a)
            .expect("register workspace A caller");
        let permit = state.begin_dispatch(Some(&identity_a)).expect("dispatch A");

        // Safe Mode has no published DB authority, but Native must still
        // rotate the trusted recovery target before main can issue identity B.
        state.bind_recovery_workspace(Some("workspace-b".to_string()));
        assert!(permit.ensure_open().is_err());
        assert!(state.begin_dispatch(Some(&identity_a)).is_err());

        let identity_b = CallerIdentity {
            workspace_id: Some("workspace-b".to_string()),
            caller_id: "main-issued-b".to_string(),
            session_id: "session-b".to_string(),
            ..identity_a
        };
        state
            .register_caller(&identity_b)
            .expect("register restore-only target caller");
        state
            .begin_dispatch(Some(&identity_b))
            .map(drop)
            .expect("recovery-bound caller can dispatch");

        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn workspace_change_invalidates_old_process_local_registration() {
        let path = temp_path("registration-workspace");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-1".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 21,
            workspace_id: Some("workspace-1".to_string()),
            session_id: "session-1".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        state.invalidate_callers();
        assert!(state.begin_dispatch(Some(&identity)).is_err());
        state.bind_workspace(Some("workspace-2".to_string()));
        assert!(
            state.register_caller(&identity).is_err(),
            "an old workspace tuple must not be re-registered after a swap"
        );
        let rebound = CallerIdentity {
            workspace_id: Some("workspace-2".to_string()),
            ..identity
        };
        state
            .register_caller(&rebound)
            .expect("register rebound caller");
        assert!(state.begin_dispatch(Some(&rebound)).is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_barrier_closes_an_existing_dispatch_permit() {
        let path = temp_path("permit-close");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let permit = state.begin_dispatch(None).expect("unrestricted permit");
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                false,
            )
            .expect("activate");
        state.begin_startup_barrier().expect("startup barrier");
        assert!(permit.ensure_open().is_err());
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn workspace_bind_revokes_a_permit_issued_before_the_swap() {
        let path = temp_path("permit-workspace-rebind");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 44,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before swap");
        state.bind_workspace(Some("workspace-b".to_string()));
        assert!(
            permit.ensure_open().is_err(),
            "workspace bind must revoke an already-issued permit"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalidate_callers_revokes_a_permit_during_a_pinned_operation() {
        let path = temp_path("permit-invalidate");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 45,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before invalidation");
        state.invalidate_callers();
        assert!(
            permit.ensure_open().is_err(),
            "caller invalidation must revoke an already-issued permit"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reauthorization_after_params_conversion_rejects_a_workspace_swap() {
        let path = temp_path("reauthorize-params-race");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 46,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before conversion");
        state
            .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
            .expect("pin reauthorization");
        let _converted_params = serde_json::json!(["converted"]);
        state.bind_workspace(Some("workspace-b".to_string()));
        assert!(
            state
                .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
                .is_err(),
            "a swap during parameter conversion must deny before SQL"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reauthorization_before_return_rejects_restore_on_the_same_path() {
        let path = temp_path("reauthorize-restore-race");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        state.bind_workspace(Some("workspace-a".to_string()));
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 47,
            workspace_id: Some("workspace-a".to_string()),
            session_id: "session-a".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        let permit = state
            .begin_dispatch(Some(&identity))
            .expect("permit before serialization");
        state
            .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
            .expect("pin reauthorization");
        let _serialized_result = serde_json::json!({ "rows": [{ "id": "a" }] });
        // Restore may keep the same path. bind_workspace must still rotate
        // the process-local binding generation and invalidate the permit.
        state.bind_workspace(Some("workspace-a".to_string()));
        assert!(
            state
                .reauthorize_dispatch(&permit, Some(&identity), Some("workspace-a"))
                .is_err(),
            "same-path restore must deny before returning the old result"
        );
        drop(permit);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn restart_does_not_restore_process_local_registration() {
        let path = temp_path("registration-restart");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let status = state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        let identity = CallerIdentity {
            profile_id: status.profile_id.clone(),
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 12,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        drop(state);

        let restarted = ProfileEgressState::new(path.clone()).expect("restart");
        assert!(restarted.begin_dispatch(Some(&identity)).is_err());
        let _ = fs::remove_file(path);
    }
    fn registered_stopped_caller(state: &ProfileEgressState) -> CallerIdentity {
        let status = state.status();
        let identity = CallerIdentity {
            profile_id: status.profile_id,
            caller_id: "main-issued".to_string(),
            caller_epoch: status.caller_epoch,
            sender_id: 31,
            workspace_id: None,
            session_id: "session-1".to_string(),
        };
        state.register_caller(&identity).expect("register caller");
        identity
    }

    #[test]
    fn legacy_provider_dispatch_is_unchanged_while_unrestricted() {
        let path = temp_path("legacy-unrestricted");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        assert!(!state.is_restricted());
        // Both with and without an identity, exactly like `begin_dispatch`.
        drop(
            state
                .begin_legacy_provider_dispatch(None)
                .expect("no identity"),
        );
        let ghost = CallerIdentity {
            profile_id: "p".into(),
            caller_id: "c".into(),
            caller_epoch: 9,
            sender_id: 1,
            workspace_id: None,
            session_id: "s".into(),
        };
        drop(
            state
                .begin_legacy_provider_dispatch(Some(&ghost))
                .expect("unrestricted ignores identity"),
        );
        assert_eq!(state.active_dispatches.load(Ordering::SeqCst), 0);
        let _ = fs::remove_file(path);
    }

    /// G-2: a registered, quiesced caller still cannot obtain a legacy
    /// provider-egress permit, although the same identity gets a generic
    /// `begin_dispatch` permit. No lease is left behind by the refusal.
    #[test]
    fn legacy_provider_dispatch_refuses_a_registered_stopped_caller_when_restricted() {
        let path = temp_path("legacy-restricted");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        state
            .activate_first_restricted_publication(
                &crate::main_grant::ConsumedProfileActivation::for_test(),
                true,
            )
            .expect("activate");
        assert!(state.is_restricted());
        let identity = registered_stopped_caller(&state);

        drop(
            state
                .begin_dispatch(Some(&identity))
                .expect("the same identity is admitted for local dispatch"),
        );
        let error = state
            .begin_legacy_provider_dispatch(Some(&identity))
            .expect_err("legacy provider egress is closed");
        let text = format!("{error:#}");
        assert!(text.starts_with(D2A_EGRESS_DENIED_MARKER), "{text}");
        assert!(text.contains("provider egress is closed"), "{text}");
        assert!(state.begin_legacy_provider_dispatch(None).is_err());
        assert_eq!(
            state.active_dispatches.load(Ordering::SeqCst),
            0,
            "a refusal must not leave a lease"
        );
        assert!(state.admissions_open.load(Ordering::SeqCst));
        let _ = fs::remove_file(path);
    }

    /// The restart case: the profile was restricted by an earlier process, so
    /// nothing in this process ever ran a stop barrier; the entries are
    /// refused all the same.
    #[test]
    fn legacy_provider_dispatch_refuses_after_restart_on_a_restricted_profile() {
        let path = temp_path("legacy-restart");
        {
            let first = ProfileEgressState::new(path.clone()).expect("state");
            first
                .activate_first_restricted_publication(
                    &crate::main_grant::ConsumedProfileActivation::for_test(),
                    true,
                )
                .expect("activate");
        }
        let restarted = ProfileEgressState::new(path.clone()).expect("restart");
        assert!(restarted.is_restricted());
        let identity = registered_stopped_caller(&restarted);
        assert!(restarted.begin_dispatch(Some(&identity)).is_ok());
        assert!(restarted
            .begin_legacy_provider_dispatch(Some(&identity))
            .is_err());
        let _ = fs::remove_file(path);
    }

    /// Ordering around the restricting transition (begin, activate, begin):
    /// a lease issued before the transition is revoked by it, and no lease is
    /// issued once the profile is restricted, even before the barrier
    /// completes and without any identity check. This is the sequential half;
    /// the two synchronised tests below pin the interleavings.
    #[test]
    fn legacy_permit_ordering_around_the_restricting_transition() {
        let path = temp_path("legacy-race");
        let state = std::sync::Arc::new(ProfileEgressState::new(path.clone()).expect("state"));
        let before = state
            .begin_legacy_provider_dispatch(None)
            .expect("pre-restriction");
        let activator = std::sync::Arc::clone(&state);
        let transition = std::thread::spawn(move || {
            activator
                .activate_first_restricted_publication(
                    &crate::main_grant::ConsumedProfileActivation::for_test(),
                    false,
                )
                .expect("activate")
        });
        transition.join().expect("transition");
        assert!(state.is_restricted());
        for _ in 0..8 {
            assert!(state.begin_legacy_provider_dispatch(None).is_err());
        }
        assert!(before.ensure_open().is_err());
        drop(before);
        let _ = fs::remove_file(path);
    }

    /// G-2 at a synchronisation point (admission side): the test thread holds
    /// the state mutex while another thread's `begin_legacy_provider_dispatch`
    /// is pending, restricts the profile through the guard, then releases.
    /// The pending admission must observe the restriction taken under the
    /// lock, be refused, and leave no lease. An implementation that decides
    /// before taking the lock (or on a separate atomic) would issue a permit
    /// here and fail this test.
    #[test]
    fn pending_legacy_admission_is_refused_when_the_profile_is_restricted_meanwhile() {
        let path = temp_path("legacy-pending-admission");
        let state = std::sync::Arc::new(ProfileEgressState::new(path.clone()).expect("state"));
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut guard = state.lock();
        let admitter = {
            let state = std::sync::Arc::clone(&state);
            let started = std::sync::Arc::clone(&started);
            std::thread::spawn(move || {
                started.store(true, Ordering::SeqCst);
                state.begin_legacy_provider_dispatch(None).map(|_| ())
            })
        };
        while !started.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        // The admission is now blocked on (or about to reach) the mutex. It
        // cannot have issued a lease while the test thread holds the guard.
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert_eq!(state.active_dispatches.load(Ordering::SeqCst), 0);
        assert!(
            !admitter.is_finished(),
            "the admission must wait for the lock"
        );
        guard.restricted = true;
        drop(guard);
        let error = admitter
            .join()
            .expect("admitter")
            .expect_err("the pending admission sees the restriction");
        assert!(
            format!("{error:#}").starts_with(D2A_EGRESS_DENIED_MARKER),
            "{error:#}"
        );
        assert_eq!(state.active_dispatches.load(Ordering::SeqCst), 0);
        let _ = fs::remove_file(path);
    }

    /// G-2 at a synchronisation point (revocation side): a permit issued
    /// before the transition stays valid while the transition is pending on
    /// the held mutex, and is revoked once the transition completes. The
    /// lease is released only by dropping the permit.
    #[test]
    fn legacy_permit_issued_before_the_transition_is_revoked_by_the_pending_transition() {
        let path = temp_path("legacy-pending-transition");
        let state = std::sync::Arc::new(ProfileEgressState::new(path.clone()).expect("state"));
        let permit = state
            .begin_legacy_provider_dispatch(None)
            .expect("pre-restriction");
        assert_eq!(state.active_dispatches.load(Ordering::SeqCst), 1);
        let started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let guard = state.lock();
        let transition = {
            let state = std::sync::Arc::clone(&state);
            let started = std::sync::Arc::clone(&started);
            std::thread::spawn(move || {
                started.store(true, Ordering::SeqCst);
                state
                    .activate_first_restricted_publication(
                        &crate::main_grant::ConsumedProfileActivation::for_test(),
                        false,
                    )
                    .expect("activate")
            })
        };
        while !started.load(Ordering::SeqCst) {
            std::thread::yield_now();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            !transition.is_finished(),
            "the transition must wait for the lock"
        );
        assert!(
            permit.ensure_open().is_ok(),
            "the permit is valid until the transition completes"
        );
        drop(guard);
        let status = transition.join().expect("transition");
        assert!(status.restricted);
        assert!(permit.ensure_open().is_err());
        assert!(state.begin_legacy_provider_dispatch(None).is_err());
        drop(permit);
        assert_eq!(state.active_dispatches.load(Ordering::SeqCst), 0);
        let _ = fs::remove_file(path);
    }

    /// K3/2 "起動時の gate" (DR-DA2-8), Negative (16): every row of the
    /// acceptance table of the state file. `Expect` is what Native loads; the
    /// Main side (ST2) fixes the same rows against this table.
    #[test]
    fn state_file_acceptance_table() {
        #[derive(Debug)]
        struct Expect {
            restricted: bool,
            handles_invalidated: bool,
            in_flight_stopped: bool,
            keeps_profile: bool,
            caller_epoch: Option<u64>,
        }
        let unrestricted = |keeps_profile: bool, epoch: u64| Expect {
            restricted: false,
            handles_invalidated: false,
            in_flight_stopped: true,
            keeps_profile,
            caller_epoch: Some(epoch),
        };
        let restricted = |stopped: bool, epoch: u64| Expect {
            restricted: true,
            handles_invalidated: true,
            in_flight_stopped: stopped,
            keeps_profile: true,
            caller_epoch: Some(epoch),
        };
        let fresh_restricted = Expect {
            restricted: true,
            handles_invalidated: true,
            in_flight_stopped: false,
            keeps_profile: false,
            caller_epoch: Some(1),
        };
        let rows: Vec<(&str, Option<Vec<u8>>, Expect)> = vec![
            ("1: no file", None, unrestricted(false, 0)),
            (
                "2: restricted v2, stopped",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":true,"handlesInvalidated":true,"inFlightStopped":true}"#.into()),
                restricted(true, 4),
            ),
            (
                "2: restricted v2, stop unconfirmed",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":true,"handlesInvalidated":true,"inFlightStopped":false}"#.into()),
                restricted(false, 4),
            ),
            (
                "3: restricted v1",
                Some(r#"{"schemaVersion":1,"profileId":"p","callerEpoch":4,"restricted":true}"#.into()),
                restricted(false, 4),
            ),
            (
                "3: restricted v2 without bits",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":true}"#.into()),
                restricted(false, 4),
            ),
            (
                "3: restricted v2, handles not invalidated",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":true,"handlesInvalidated":false,"inFlightStopped":true}"#.into()),
                restricted(false, 4),
            ),
            (
                "4: unrestricted v2 (J-1)",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":false,"handlesInvalidated":true,"inFlightStopped":false}"#.into()),
                unrestricted(true, 4),
            ),
            (
                "4: unrestricted v1 (J-1)",
                Some(r#"{"schemaVersion":1,"profileId":"p","callerEpoch":0,"restricted":false}"#.into()),
                unrestricted(true, 0),
            ),
            (
                "4: unrestricted v2 with the unrestricted bits",
                Some(r#"{"schemaVersion":2,"profileId":"p","callerEpoch":0,"restricted":false,"handlesInvalidated":false,"inFlightStopped":true}"#.into()),
                unrestricted(true, 0),
            ),
            ("5: broken JSON", Some("{not json".into()), fresh_restricted),
            (
                // Not UTF-8 is broken content, not an unreadable file (F6).
                "5: not UTF-8",
                Some(vec![0xff, 0xfe, b'{', 0x80, b'}']),
                Expect { restricted: true, handles_invalidated: true, in_flight_stopped: false, keeps_profile: false, caller_epoch: Some(1) },
            ),
            (
                "5: unknown version",
                Some(r#"{"schemaVersion":3,"profileId":"p","callerEpoch":4,"restricted":false}"#.into()),
                Expect { restricted: true, handles_invalidated: true, in_flight_stopped: false, keeps_profile: false, caller_epoch: Some(1) },
            ),
            (
                "5: blank profileId",
                Some(r#"{"schemaVersion":2,"profileId":" ","callerEpoch":4,"restricted":false}"#.into()),
                Expect { restricted: true, handles_invalidated: true, in_flight_stopped: false, keeps_profile: false, caller_epoch: Some(1) },
            ),
            (
                "5: untrimmed profileId",
                Some(r#"{"schemaVersion":2,"profileId":" p","callerEpoch":4,"restricted":true}"#.into()),
                Expect { restricted: true, handles_invalidated: true, in_flight_stopped: false, keeps_profile: false, caller_epoch: Some(1) },
            ),
        ];
        for (label, content, expect) in rows {
            let path = temp_path("acceptance");
            if let Some(content) = &content {
                fs::write(&path, content).expect("write state file");
            }
            let state = ProfileEgressState::new(path.clone()).expect(label);
            let status = state.status();
            assert_eq!(status.restricted, expect.restricted, "{label}");
            assert_eq!(
                status.handles_invalidated, expect.handles_invalidated,
                "{label}"
            );
            assert_eq!(
                status.in_flight_stopped, expect.in_flight_stopped,
                "{label}"
            );
            assert_eq!(status.profile_id == "p", expect.keeps_profile, "{label}");
            if let Some(epoch) = expect.caller_epoch {
                assert_eq!(status.caller_epoch, epoch, "{label}");
            }
            assert_eq!(status.unavailable_reason, None, "{label}");
            // Main's acceptance (`isValidNativeProfileEgressStatus`) needs
            // `handlesInvalidated === restricted`: every unrestricted row
            // satisfies it without a barrier (J-1).
            if !status.restricted {
                assert!(
                    !status.handles_invalidated && status.in_flight_stopped,
                    "{label}"
                );
                assert!(
                    state.begin_dispatch(None).is_ok(),
                    "{label}: admissions open"
                );
            }
            // Loading never rewrites the file (J-1 included).
            match &content {
                Some(content) => {
                    assert_eq!(&fs::read(&path).expect(label), content, "{label}")
                }
                None => assert!(!path.exists(), "{label}"),
            }
            // A restricted row runs the barrier again, which rewrites the
            // file in the v2 form with the same epoch (row 3).
            if status.restricted {
                state.begin_startup_barrier().expect(label);
                state.confirm_in_flight_stopped().expect(label);
                let rewritten: serde_json::Value =
                    serde_json::from_str(&fs::read_to_string(&path).expect(label)).expect(label);
                assert_eq!(rewritten["schemaVersion"], 2, "{label}");
                assert_eq!(rewritten["restricted"], true, "{label}");
                assert_eq!(rewritten["handlesInvalidated"], true, "{label}");
                assert_eq!(rewritten["inFlightStopped"], true, "{label}");
                assert_eq!(rewritten["callerEpoch"], status.caller_epoch, "{label}");
            }
            let _ = fs::remove_file(path);
        }

        // Row 6: an unreadable file builds nothing, and the message is the
        // closed reason without the path (P3-9).
        let directory = temp_path("unreadable");
        fs::create_dir_all(&directory).expect("directory in place of the file");
        let error = match ProfileEgressState::new(directory.clone()) {
            Ok(_) => panic!("a directory is not a readable state file"),
            Err(error) => format!("{error:#}"),
        };
        assert!(
            error.starts_with("PROFILE_EGRESS_UNAVAILABLE:state-file-unreadable"),
            "{error}"
        );
        assert!(!error.contains(&directory.display().to_string()), "{error}");
        let _ = fs::remove_dir_all(directory);

        // Row 7: a restricted file whose barrier cannot persist keeps the
        // admissions closed and reports `state-file-unwritable`.
        let parent = temp_path("unwritable-parent");
        fs::create_dir_all(&parent).expect("parent");
        let path = parent.join("profile-egress.json");
        fs::write(
            &path,
            r#"{"schemaVersion":2,"profileId":"p","callerEpoch":4,"restricted":true,"handlesInvalidated":true,"inFlightStopped":true}"#,
        )
        .expect("write state file");
        let state = ProfileEgressState::new(path.clone()).expect("restricted state");
        fs::remove_file(&path).expect("remove the file");
        fs::create_dir_all(path.join("blocker")).expect("a directory where the file goes");
        assert!(state.begin_startup_barrier().is_err());
        let status = state.status();
        assert!(status.restricted && !status.in_flight_stopped);
        assert_eq!(status.unavailable_reason, Some("state-file-unwritable"));
        assert!(state.begin_dispatch(None).is_err());
        let _ = fs::remove_dir_all(parent);
    }

    /// The healthy status carries no `unavailableReason` field.
    #[test]
    fn a_healthy_status_has_no_unavailable_reason_on_the_wire() {
        let path = temp_path("status-wire");
        let state = ProfileEgressState::new(path.clone()).expect("state");
        let json = serde_json::to_value(state.status()).expect("status JSON");
        assert!(json.get("unavailableReason").is_none(), "{json}");
        state.mark_unavailable(ProfileEgressUnavailable::BarrierTimeout);
        state.mark_unavailable(ProfileEgressUnavailable::ActivationFailed);
        let json = serde_json::to_value(state.status()).expect("status JSON");
        assert_eq!(
            json["unavailableReason"], "barrier-timeout",
            "the first reason stays"
        );
        assert_eq!(
            ProfileEgressUnavailable::StateFileUnwritable.message(),
            "PROFILE_EGRESS_UNAVAILABLE:state-file-unwritable"
        );
    }
}
