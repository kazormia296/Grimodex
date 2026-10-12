//! Process-local NIR-1 startup admission gate.
//!
//! The gate starts Closed and is closed again by every lifecycle seam edge
//! (transition admission, Ready publication, unavailability, shutdown). It
//! moves to Recovering only for the exact Ready entry named by the latest
//! closure, and to Open only after the #610 recovery sweep for that same
//! entry has exhausted every page and its blocking task has joined. Leases
//! are issued only from an exact Open entry and are counted per closure
//! epoch, so a later closure can wait for the actual Drop of earlier leases.
//!
//! The gate performs no recovery, database work or lifecycle publication.
//! Its mutex guards only short state updates; waits use its Condvar with a
//! finite deadline and never run under Core, Projection or database locks.
//! Poison or epoch exhaustion keeps the gate permanently Closed.

use std::collections::BTreeMap;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use grimodex_db::workspace_lifecycle::{
    LifecycleEdge, LiveBinding, OperationId, StateRevision, WorkspaceLifecycleObserver,
};

/// Upper bound for every wait on lease retirement.
pub(crate) const NIR1_STARTUP_LEASE_DRAIN_LIMIT: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Nir1StartupDrainError {
    /// Earlier leases were still held at the deadline. Their counts remain.
    TimedOut,
    /// A newer closure (including shutdown) replaced the awaited one.
    Stale,
    /// The gate is permanently Closed.
    Poisoned,
}

#[derive(Clone)]
pub(crate) struct Nir1StartupAdmissionGate {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<GateState>,
    changed: Condvar,
}

struct GateState {
    epoch: u64,
    phase: Phase,
    closure: Closure,
    leases: BTreeMap<u64, usize>,
    poisoned: bool,
    shutdown: bool,
    #[cfg(test)]
    waiters: usize,
    #[cfg(test)]
    timeout_wakes: usize,
}

enum Phase {
    Closed,
    Recovering { entry: Arc<ReadyEntry>, swept: bool },
    Open(Arc<ReadyEntry>),
}

/// Cause of the current closure. Only `Ready` can start recovery.
enum Closure {
    Initial,
    Transition(OperationId),
    Ready(Arc<ReadyEntry>),
    Unavailable,
    Shutdown,
    /// The Ready entry's recovery ended without a sweep proof.
    Consumed,
}

struct ReadyEntry {
    binding: LiveBinding,
    revision: StateRevision,
}

impl ReadyEntry {
    fn is(&self, binding: &LiveBinding, revision: StateRevision) -> bool {
        self.revision == revision && &self.binding == binding
    }
}

/// Exclusive recovery owner for one exact Ready entry. Dropping it without
/// `record_complete_sweep` returns the gate to Closed and consumes the entry.
pub(crate) struct Nir1StartupRecovery {
    shared: Arc<Shared>,
    epoch: u64,
    entry: Arc<ReadyEntry>,
    recorded: bool,
}

/// Short admission lease for one exact Open Ready entry.
// DT-1 provides the lease API only; DT-2 routes attempt create/claim here.
#[allow(dead_code)]
pub(crate) struct Nir1StartupLease {
    shared: Arc<Shared>,
    epoch: u64,
    entry: Arc<ReadyEntry>,
}

impl Default for Nir1StartupAdmissionGate {
    fn default() -> Self {
        Self::new()
    }
}

impl Nir1StartupAdmissionGate {
    pub(crate) fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(GateState {
                    epoch: 0,
                    phase: Phase::Closed,
                    closure: Closure::Initial,
                    leases: BTreeMap::new(),
                    poisoned: false,
                    shutdown: false,
                    #[cfg(test)]
                    waiters: 0,
                    #[cfg(test)]
                    timeout_wakes: 0,
                }),
                changed: Condvar::new(),
            }),
        }
    }

    /// Close permanently for shutdown. Idempotent and independent of the
    /// lifecycle Core, so a poisoned Core cannot leave the gate open.
    pub(crate) fn close_for_shutdown(&self) {
        self.close(Closure::Shutdown);
    }

    fn close(&self, closure: Closure) {
        let mut state = self.shared.lock_state();
        state.phase = Phase::Closed;
        if matches!(closure, Closure::Shutdown) {
            state.shutdown = true;
        }
        state.closure = if state.shutdown {
            Closure::Shutdown
        } else {
            closure
        };
        match state.epoch.checked_add(1) {
            Some(epoch) => state.epoch = epoch,
            None => state.poisoned = true,
        }
        drop(state);
        // Wake every bounded waiter so it observes the newer closure now
        // instead of at its deadline.
        self.shared.changed.notify_all();
    }

    /// Wait, at most `max_wait` (capped at 250 ms), until every lease issued
    /// before the closure of transition `operation_id` has actually dropped.
    /// Called before that transition publishes Ready, without any Core,
    /// Projection or database lock held. A timeout leaves the gate Closed
    /// and the leases counted.
    pub(crate) fn drain_before_ready(
        &self,
        operation_id: OperationId,
        max_wait: Duration,
    ) -> Result<(), Nir1StartupDrainError> {
        let deadline = Instant::now() + max_wait.min(NIR1_STARTUP_LEASE_DRAIN_LIMIT);
        let state = self.shared.lock_state_checked()?;
        let epoch = state.epoch;
        let state = self.shared.wait_for_leases(state, epoch, deadline, |state| {
            matches!(state.closure, Closure::Transition(owner) if owner == operation_id)
                && matches!(state.phase, Phase::Closed)
        })?;
        drop(state);
        Ok(())
    }

    /// Begin recovery for the exact Ready entry that closed the gate most
    /// recently, after leases from earlier closures have dropped (bounded).
    /// Returns None for a stale, consumed, shut down or poisoned entry.
    pub(crate) fn begin_recovery(
        &self,
        binding: &LiveBinding,
        ready_revision: StateRevision,
        max_wait: Duration,
    ) -> Option<Nir1StartupRecovery> {
        let deadline = Instant::now() + max_wait.min(NIR1_STARTUP_LEASE_DRAIN_LIMIT);
        let state = self.shared.lock_state_checked().ok()?;
        let entry = match (&state.closure, &state.phase) {
            (Closure::Ready(entry), Phase::Closed) if entry.is(binding, ready_revision) => {
                Arc::clone(entry)
            }
            _ => return None,
        };
        let epoch = state.epoch;
        let mut state = self
            .shared
            .wait_for_leases(state, epoch, deadline, |state| {
                matches!(&state.closure, Closure::Ready(current) if Arc::ptr_eq(current, &entry))
                    && matches!(state.phase, Phase::Closed)
            })
            .ok()?;
        state.phase = Phase::Recovering {
            entry: Arc::clone(&entry),
            swept: false,
        };
        drop(state);
        Some(Nir1StartupRecovery {
            shared: Arc::clone(&self.shared),
            epoch,
            entry,
            recorded: false,
        })
    }

    /// Open the exact Ready entry after its sweep owner recorded a complete
    /// sweep and the supervisor observed the blocking task's successful Join.
    /// An older owner, or any closure after the sweep, cannot open the gate.
    pub(crate) fn open_after_joined_sweep(
        &self,
        binding: &LiveBinding,
        ready_revision: StateRevision,
    ) -> bool {
        let Ok(mut state) = self.shared.lock_state_checked() else {
            return false;
        };
        let entry = match &state.phase {
            Phase::Recovering { entry, swept: true } if entry.is(binding, ready_revision) => {
                Arc::clone(entry)
            }
            _ => return false,
        };
        if has_leases_through(&state, state.epoch) {
            return false;
        }
        state.phase = Phase::Open(entry);
        true
    }

    /// Issue a lease only while the exact Ready entry is Open.
    #[allow(dead_code)]
    pub(crate) fn try_lease(
        &self,
        binding: &LiveBinding,
        ready_revision: StateRevision,
    ) -> Option<Nir1StartupLease> {
        let mut state = self.shared.lock_state_checked().ok()?;
        let entry = match &state.phase {
            Phase::Open(entry) if entry.is(binding, ready_revision) => Arc::clone(entry),
            _ => return None,
        };
        let epoch = state.epoch;
        let count = state.leases.entry(epoch).or_default();
        *count = count.checked_add(1)?;
        drop(state);
        Some(Nir1StartupLease {
            shared: Arc::clone(&self.shared),
            epoch,
            entry,
        })
    }

    #[cfg(test)]
    pub(crate) fn is_open_for(&self, binding: &LiveBinding, ready_revision: StateRevision) -> bool {
        matches!(
            &self.shared.lock_state().phase,
            Phase::Open(entry) if entry.is(binding, ready_revision)
        )
    }

    #[cfg(test)]
    pub(crate) fn is_closed(&self) -> bool {
        matches!(self.shared.lock_state().phase, Phase::Closed)
    }

    #[cfg(test)]
    pub(crate) fn epoch(&self) -> u64 {
        self.shared.lock_state().epoch
    }

    #[cfg(test)]
    pub(crate) fn active_lease_count(&self) -> usize {
        self.shared
            .lock_state()
            .leases
            .values()
            .fold(0, |total, count| total.saturating_add(*count))
    }

    #[cfg(test)]
    pub(crate) fn waiter_count(&self) -> usize {
        self.shared.lock_state().waiters
    }

    /// Bounded waits that ended at their deadline rather than by a wake.
    #[cfg(test)]
    pub(crate) fn timeout_wake_count(&self) -> usize {
        self.shared.lock_state().timeout_wakes
    }

    /// The latest closure is this exact Ready entry and no recovery owner
    /// has started on it.
    #[cfg(test)]
    pub(crate) fn awaits_recovery_for(
        &self,
        binding: &LiveBinding,
        ready_revision: StateRevision,
    ) -> bool {
        let state = self.shared.lock_state();
        matches!(&state.closure, Closure::Ready(entry) if entry.is(binding, ready_revision))
            && matches!(state.phase, Phase::Closed)
    }
}

impl WorkspaceLifecycleObserver for Nir1StartupAdmissionGate {
    fn on_lifecycle_edge(&self, edge: &LifecycleEdge) {
        let closure = match edge {
            LifecycleEdge::TransitionAdmitted { operation_id, .. } => {
                Closure::Transition(*operation_id)
            }
            LifecycleEdge::ReadyPublished { binding, revision } => {
                Closure::Ready(Arc::new(ReadyEntry {
                    binding: binding.clone(),
                    revision: *revision,
                }))
            }
            LifecycleEdge::ShutdownRequested { .. } => Closure::Shutdown,
            // Unknown future edges close conservatively.
            _ => Closure::Unavailable,
        };
        self.close(closure);
    }
}

impl Nir1StartupRecovery {
    /// Record that the sweep for this exact entry exhausted every page
    /// without cutoff, cancel or error. Opening still waits for the Join.
    pub(crate) fn record_complete_sweep(mut self) -> bool {
        let Ok(mut state) = self.shared.lock_state_checked() else {
            return false;
        };
        if state.epoch != self.epoch {
            return false;
        }
        match &mut state.phase {
            Phase::Recovering { entry, swept } if Arc::ptr_eq(entry, &self.entry) => {
                *swept = true;
                self.recorded = true;
                true
            }
            _ => false,
        }
    }
}

impl Drop for Nir1StartupRecovery {
    fn drop(&mut self) {
        if self.recorded {
            return;
        }
        let mut state = self.shared.lock_state();
        if state.epoch == self.epoch
            && matches!(
                &state.phase,
                Phase::Recovering { entry, .. } if Arc::ptr_eq(entry, &self.entry)
            )
        {
            state.phase = Phase::Closed;
            state.closure = Closure::Consumed;
        }
    }
}

#[allow(dead_code)]
impl Nir1StartupLease {
    /// Recheck after work: false once any closure has replaced the Open
    /// entry this lease was issued from.
    pub(crate) fn is_current(&self) -> bool {
        let Ok(state) = self.shared.lock_state_checked() else {
            return false;
        };
        state.epoch == self.epoch
            && matches!(&state.phase, Phase::Open(entry) if Arc::ptr_eq(entry, &self.entry))
    }
}

impl Drop for Nir1StartupLease {
    fn drop(&mut self) {
        let mut state = self.shared.lock_state();
        if let Some(count) = state.leases.get_mut(&self.epoch) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.leases.remove(&self.epoch);
            }
        }
        drop(state);
        self.shared.changed.notify_all();
    }
}

impl Shared {
    /// Lock for bookkeeping; a poisoned mutex permanently closes the gate.
    fn lock_state(&self) -> MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|poisoned| {
            let mut state = poisoned.into_inner();
            fail_closed(&mut state);
            state
        })
    }

    /// Lock for admission decisions; poison, epoch exhaustion and shutdown
    /// deny every transition out of Closed.
    fn lock_state_checked(&self) -> Result<MutexGuard<'_, GateState>, Nir1StartupDrainError> {
        let state = self.lock_state();
        if state.poisoned {
            return Err(Nir1StartupDrainError::Poisoned);
        }
        if state.shutdown {
            return Err(Nir1StartupDrainError::Stale);
        }
        Ok(state)
    }

    /// Wait until no lease from `epoch` or earlier remains, while `current`
    /// still holds and the epoch is unchanged. Spurious and unrelated wakes
    /// re-check against the same absolute deadline.
    fn wait_for_leases<'a>(
        &'a self,
        mut state: MutexGuard<'a, GateState>,
        epoch: u64,
        deadline: Instant,
        current: impl Fn(&GateState) -> bool,
    ) -> Result<MutexGuard<'a, GateState>, Nir1StartupDrainError> {
        loop {
            if state.poisoned {
                return Err(Nir1StartupDrainError::Poisoned);
            }
            if state.shutdown || state.epoch != epoch || !current(&state) {
                return Err(Nir1StartupDrainError::Stale);
            }
            if !has_leases_through(&state, epoch) {
                return Ok(state);
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(Nir1StartupDrainError::TimedOut);
            }
            #[cfg(test)]
            {
                state.waiters += 1;
            }
            let (next, _wake) = match self.changed.wait_timeout(state, remaining) {
                Ok(woken) => woken,
                Err(poisoned) => {
                    let (mut state, wake) = poisoned.into_inner();
                    fail_closed(&mut state);
                    (state, wake)
                }
            };
            state = next;
            #[cfg(test)]
            {
                state.waiters -= 1;
                if _wake.timed_out() {
                    state.timeout_wakes += 1;
                }
            }
        }
    }
}

fn fail_closed(state: &mut GateState) {
    state.poisoned = true;
    state.phase = Phase::Closed;
}

fn has_leases_through(state: &GateState, epoch: u64) -> bool {
    state.leases.range(..=epoch).any(|(_, count)| *count != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use grimodex_db::workspace_lifecycle::AdmissionKind;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::mpsc;
    use std::thread;

    fn binding(instance: u64, generation: u64) -> LiveBinding {
        LiveBinding::new("/workspace", "workspace-id", instance, generation)
    }

    fn admit(gate: &Nir1StartupAdmissionGate, operation_id: u64) {
        gate.on_lifecycle_edge(&LifecycleEdge::TransitionAdmitted {
            operation_id: OperationId::new(operation_id),
            kind: AdmissionKind::Open,
            revision: 1,
        });
    }

    fn publish(gate: &Nir1StartupAdmissionGate, binding: &LiveBinding, revision: StateRevision) {
        gate.on_lifecycle_edge(&LifecycleEdge::ReadyPublished {
            binding: binding.clone(),
            revision,
        });
    }

    fn open(gate: &Nir1StartupAdmissionGate, binding: &LiveBinding, revision: StateRevision) {
        publish(gate, binding, revision);
        let recovery = gate
            .begin_recovery(binding, revision, NIR1_STARTUP_LEASE_DRAIN_LIMIT)
            .expect("exact Ready entry recovery");
        assert!(recovery.record_complete_sweep());
        assert!(gate.open_after_joined_sweep(binding, revision));
    }

    fn wait_for_waiter(gate: &Nir1StartupAdmissionGate) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while gate.waiter_count() == 0 {
            assert!(Instant::now() < deadline, "waiter entered the Condvar");
            thread::yield_now();
        }
    }

    fn poison(gate: &Nir1StartupAdmissionGate) {
        let shared = Arc::clone(&gate.shared);
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _state = shared.state.lock().expect("unpoisoned gate");
            panic!("poison gate state");
        }));
        assert!(panic.is_err());
    }

    #[test]
    fn starts_closed_and_issues_leases_only_for_the_exact_open_entry() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        assert!(gate.is_closed());
        assert!(gate.try_lease(&ready, 7).is_none());
        assert!(
            gate.begin_recovery(&ready, 7, Duration::ZERO).is_none(),
            "the initial closure names no Ready entry"
        );

        publish(&gate, &ready, 7);
        assert!(gate.try_lease(&ready, 7).is_none(), "Ready alone is not Open");
        let recovery = gate
            .begin_recovery(&ready, 7, Duration::ZERO)
            .expect("exact Ready entry");
        assert!(gate.try_lease(&ready, 7).is_none(), "Recovering is closed");
        assert!(
            !gate.open_after_joined_sweep(&ready, 7),
            "Join without a complete sweep cannot open"
        );
        assert!(recovery.record_complete_sweep());
        assert!(gate.try_lease(&ready, 7).is_none(), "sweep without Join is closed");
        assert!(gate.open_after_joined_sweep(&ready, 7));

        let lease = gate.try_lease(&ready, 7).expect("exact Open entry");
        assert!(lease.is_current());
        assert!(gate.try_lease(&ready, 8).is_none());
        assert!(gate.try_lease(&binding(2, 1), 7).is_none());
        assert!(gate.try_lease(&binding(1, 2), 7).is_none());
        drop(lease);
        assert_eq!(gate.active_lease_count(), 0);
    }

    #[test]
    fn every_lifecycle_edge_closes_and_advances_the_epoch() {
        let ready = binding(1, 1);
        let edges = [
            LifecycleEdge::TransitionAdmitted {
                operation_id: OperationId::new(3),
                kind: AdmissionKind::Restore,
                revision: 9,
            },
            LifecycleEdge::ReadyPublished {
                binding: ready.clone(),
                revision: 9,
            },
            LifecycleEdge::Unavailable { revision: 9 },
            LifecycleEdge::ShutdownRequested { revision: 9 },
        ];
        for edge in edges {
            let gate = Nir1StartupAdmissionGate::new();
            open(&gate, &ready, 7);
            let lease = gate.try_lease(&ready, 7).expect("Open lease");
            let epoch = gate.epoch();
            gate.on_lifecycle_edge(&edge);
            assert!(gate.is_closed(), "{edge:?} closes");
            assert_eq!(gate.epoch(), epoch + 1, "{edge:?} advances the epoch");
            assert!(!lease.is_current(), "{edge:?} retires lease currency");
            assert!(gate.try_lease(&ready, 7).is_none());
            assert_eq!(gate.active_lease_count(), 1, "closure is not retirement");
            drop(lease);
            assert_eq!(gate.active_lease_count(), 0);
        }
    }

    #[test]
    fn drain_returns_only_after_the_actual_prior_lease_drop() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let prior = gate.try_lease(&ready, 7).expect("prior lease");
        admit(&gate, 11);

        let (result_tx, result_rx) = mpsc::channel();
        let waiter_gate = gate.clone();
        let waiter = thread::spawn(move || {
            result_tx
                .send(
                    waiter_gate
                        .drain_before_ready(OperationId::new(11), NIR1_STARTUP_LEASE_DRAIN_LIMIT),
                )
                .expect("send drain result");
        });
        wait_for_waiter(&gate);
        assert!(result_rx.try_recv().is_err(), "drain waits for the lease");
        drop(prior);
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("Drop wakes the drain"),
            Ok(())
        );
        waiter.join().expect("waiter joined");
        assert!(gate.is_closed(), "drain never opens the gate");
    }

    #[test]
    fn drain_timeout_is_bounded_and_keeps_the_gate_closed_and_lease_counted() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let prior = gate.try_lease(&ready, 7).expect("prior lease");
        admit(&gate, 11);

        let started = Instant::now();
        assert_eq!(
            gate.drain_before_ready(OperationId::new(11), Duration::from_secs(30)),
            Err(Nir1StartupDrainError::TimedOut),
            "a caller budget above the limit is capped"
        );
        let elapsed = started.elapsed();
        assert!(elapsed >= NIR1_STARTUP_LEASE_DRAIN_LIMIT);
        // Generous slack for loaded hosts; the 30 s request is still capped.
        assert!(elapsed < NIR1_STARTUP_LEASE_DRAIN_LIMIT + Duration::from_secs(5));
        assert_eq!(gate.active_lease_count(), 1, "timeout is not retirement");
        assert!(gate.is_closed());
        assert!(gate.try_lease(&ready, 7).is_none());

        publish(&gate, &binding(2, 2), 8);
        assert!(
            gate.begin_recovery(&binding(2, 2), 8, Duration::from_millis(5))
                .is_none(),
            "recovery cannot start while an earlier lease is live"
        );
        drop(prior);
        let recovery = gate
            .begin_recovery(&binding(2, 2), 8, Duration::ZERO)
            .expect("recovery after the actual Drop");
        assert!(recovery.record_complete_sweep());
        assert!(gate.open_after_joined_sweep(&binding(2, 2), 8));
    }

    #[test]
    fn shutdown_wakes_a_blocked_drain_waiter_before_its_deadline() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let prior = gate.try_lease(&ready, 7).expect("prior lease");
        admit(&gate, 11);
        let (result_tx, result_rx) = mpsc::channel();
        let waiter_gate = gate.clone();
        let waiter = thread::spawn(move || {
            result_tx
                .send(
                    waiter_gate
                        .drain_before_ready(OperationId::new(11), NIR1_STARTUP_LEASE_DRAIN_LIMIT),
                )
                .expect("send drain result");
        });
        wait_for_waiter(&gate);

        gate.on_lifecycle_edge(&LifecycleEdge::ShutdownRequested { revision: 12 });
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("shutdown wakes the waiter"),
            Err(Nir1StartupDrainError::Stale)
        );
        // A deadline expiry would also read Stale after shutdown; the wake
        // itself is what this test proves.
        assert_eq!(gate.timeout_wake_count(), 0, "woken, not timed out");
        assert_eq!(gate.active_lease_count(), 1, "the waiter retired nothing");
        waiter.join().expect("waiter joined");

        gate.close_for_shutdown();
        publish(&gate, &ready, 13);
        assert!(
            gate.begin_recovery(&ready, 13, Duration::ZERO).is_none(),
            "shutdown is permanent"
        );
        drop(prior);
        assert_eq!(gate.active_lease_count(), 0);
    }

    #[test]
    fn closure_descriptor_race_rejects_stale_drain_and_recovery_owners() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready_a = binding(1, 1);
        open(&gate, &ready_a, 7);
        let prior = gate.try_lease(&ready_a, 7).expect("prior lease");

        // Transition 11 is replaced by 12 while 11 waits: the old closure
        // descriptor is stale and its waiter is woken, not timed out.
        admit(&gate, 11);
        let (result_tx, result_rx) = mpsc::channel();
        let waiter_gate = gate.clone();
        let waiter = thread::spawn(move || {
            result_tx
                .send(
                    waiter_gate
                        .drain_before_ready(OperationId::new(11), NIR1_STARTUP_LEASE_DRAIN_LIMIT),
                )
                .expect("send drain result");
        });
        wait_for_waiter(&gate);
        admit(&gate, 12);
        assert_eq!(
            result_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("newer closure wakes the stale waiter"),
            Err(Nir1StartupDrainError::Stale)
        );
        waiter.join().expect("waiter joined");
        assert_eq!(gate.timeout_wake_count(), 0, "woken, not timed out");
        assert_eq!(
            gate.drain_before_ready(OperationId::new(11), Duration::ZERO),
            Err(Nir1StartupDrainError::Stale)
        );

        // A recovery owner waiting on entry B is woken by Ready entry C and
        // cannot start or open C.
        let ready_b = binding(2, 2);
        publish(&gate, &ready_b, 8);
        let (recovery_tx, recovery_rx) = mpsc::channel();
        let recovery_gate = gate.clone();
        let recovery_binding = ready_b.clone();
        let recovery_waiter = thread::spawn(move || {
            recovery_tx
                .send(
                    recovery_gate
                        .begin_recovery(&recovery_binding, 8, NIR1_STARTUP_LEASE_DRAIN_LIMIT)
                        .is_some(),
                )
                .expect("send recovery result");
        });
        wait_for_waiter(&gate);
        let ready_c = binding(3, 3);
        publish(&gate, &ready_c, 9);
        assert!(!recovery_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("newer Ready entry wakes the stale recovery owner"));
        recovery_waiter.join().expect("recovery waiter joined");
        assert_eq!(gate.timeout_wake_count(), 0, "woken, not timed out");
        assert!(gate.begin_recovery(&ready_b, 8, Duration::ZERO).is_none());
        assert!(!gate.open_after_joined_sweep(&ready_b, 8));

        drop(prior);
        let current = gate
            .begin_recovery(&ready_c, 9, Duration::ZERO)
            .expect("current Ready entry");
        assert!(current.record_complete_sweep());
        assert!(gate.open_after_joined_sweep(&ready_c, 9));
    }

    #[test]
    fn stale_sweep_owner_cannot_record_or_open_a_newer_ready_entry() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready_a = binding(1, 1);
        publish(&gate, &ready_a, 7);
        let stale = gate
            .begin_recovery(&ready_a, 7, Duration::ZERO)
            .expect("A recovery");
        let ready_b = binding(2, 2);
        publish(&gate, &ready_b, 8);
        assert!(!stale.record_complete_sweep(), "A's sweep is for an old entry");
        assert!(!gate.open_after_joined_sweep(&ready_a, 7));
        assert!(gate.is_closed());

        // Same binding, newer revision: still a different Ready entry.
        let recovery_b = gate
            .begin_recovery(&ready_b, 8, Duration::ZERO)
            .expect("B recovery");
        assert!(recovery_b.record_complete_sweep());
        publish(&gate, &ready_b, 9);
        assert!(!gate.open_after_joined_sweep(&ready_b, 8));
        let recovery_b9 = gate
            .begin_recovery(&ready_b, 9, Duration::ZERO)
            .expect("B revision 9 recovery");
        assert!(recovery_b9.record_complete_sweep());
        assert!(gate.open_after_joined_sweep(&ready_b, 9));
        assert!(gate.try_lease(&ready_b, 8).is_none());
        assert!(gate.try_lease(&ready_b, 9).is_some());
    }

    #[test]
    fn incomplete_recovery_stays_closed_consumes_the_entry_and_retries_at_a_new_entry() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        publish(&gate, &ready, 7);
        let recovery = gate
            .begin_recovery(&ready, 7, Duration::ZERO)
            .expect("recovery");
        drop(recovery);
        assert!(gate.is_closed());
        assert!(!gate.open_after_joined_sweep(&ready, 7));
        assert!(
            gate.begin_recovery(&ready, 7, Duration::ZERO).is_none(),
            "the incomplete entry is consumed"
        );

        let panic = catch_unwind(AssertUnwindSafe(|| {
            publish(&gate, &ready, 8);
            let _recovery = gate
                .begin_recovery(&ready, 8, Duration::ZERO)
                .expect("recovery before panic");
            panic!("sweep worker panic");
        }));
        assert!(panic.is_err());
        assert!(gate.is_closed());
        assert!(gate.begin_recovery(&ready, 8, Duration::ZERO).is_none());

        open(&gate, &ready, 9);
        assert!(gate.try_lease(&ready, 9).is_some());
    }

    #[test]
    fn poisoned_gate_is_permanently_closed() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let lease = gate.try_lease(&ready, 7).expect("lease before poison");
        poison(&gate);

        assert!(!lease.is_current());
        assert!(gate.try_lease(&ready, 7).is_none());
        admit(&gate, 11);
        assert_eq!(
            gate.drain_before_ready(OperationId::new(11), Duration::ZERO),
            Err(Nir1StartupDrainError::Poisoned)
        );
        publish(&gate, &ready, 8);
        assert!(gate.begin_recovery(&ready, 8, Duration::ZERO).is_none());
        drop(lease);
        assert_eq!(gate.active_lease_count(), 0, "Drop still retires after poison");
    }

    #[test]
    fn epoch_exhaustion_is_permanently_closed() {
        let gate = Nir1StartupAdmissionGate::new();
        gate.shared.lock_state().epoch = u64::MAX;
        let ready = binding(1, 1);
        publish(&gate, &ready, 7);
        assert!(gate.begin_recovery(&ready, 7, Duration::ZERO).is_none());
        assert!(gate.try_lease(&ready, 7).is_none());
    }

    #[test]
    fn panicking_lease_owner_retires_its_count() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let panic = catch_unwind(AssertUnwindSafe(|| {
            let _lease = gate.try_lease(&ready, 7).expect("lease before panic");
            panic!("lease owner panic");
        }));
        assert!(panic.is_err());
        assert_eq!(gate.active_lease_count(), 0);
        admit(&gate, 11);
        assert_eq!(
            gate.drain_before_ready(OperationId::new(11), Duration::ZERO),
            Ok(())
        );
    }
}
