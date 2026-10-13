//! Process-local NIR-1 startup admission gate.
//!
//! The gate starts Closed and is closed again by every lifecycle seam edge
//! (transition admission, Ready publication, unavailability, shutdown). It
//! moves to Recovering only for the exact Ready entry named by the latest
//! closure, and to Open only after the #610 recovery sweep for that same
//! entry has exhausted every page and its blocking task has joined (the
//! supervisor hands the one-shot sweep proof from the task's Join to
//! `open_after_joined_sweep`). Leases are issued only from an Open entry and
//! are counted per closure epoch, so a later closure can wait for the actual
//! Drop of earlier leases.
//!
//! A Ready entry is identified by its exact binding and the closure epoch.
//! Revision-only Core changes (quarantine fences, background descriptor
//! completion) are not edges, so a claimant presents its binding and the
//! lease keeps the entry's revision. Lease currency is mirrored in atomics
//! (epoch and poison) so it can be read without this mutex, for example from
//! an SQLite progress hook while the connection mutex is held.
//!
//! The gate performs no recovery, database work or lifecycle publication.
//! Its mutex guards only short state updates; waits use its Condvar with a
//! finite deadline and never run under Core, Projection or database locks.
//! Poison or epoch exhaustion keeps the gate permanently Closed.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Mirrors `GateState::epoch`, written under the mutex (Release).
    epoch_mirror: AtomicU64,
    /// Mirrors `GateState::poisoned`, written under the mutex (Release).
    poisoned_mirror: AtomicBool,
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
    /// The Ready entry's recovery ended without a sweep proof, or the Open
    /// entry was quarantined.
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

/// One-shot proof that the sweep for one exact Ready entry completed. It is
/// not Clone; only `open_after_joined_sweep` consumes it. Dropping it unused
/// closes and consumes that same entry (never a newer one).
pub(crate) struct Nir1SweepProof {
    shared: Arc<Shared>,
    epoch: u64,
    entry: Arc<ReadyEntry>,
    used: bool,
}

/// Short admission lease for one exact Open Ready entry.
pub(crate) struct Nir1StartupLease {
    shared: Arc<Shared>,
    epoch: u64,
    entry: Arc<ReadyEntry>,
}

/// Uncounted reference to the Open entry a lease was issued from. It answers
/// the same currency question as the lease, without any lock.
#[derive(Clone)]
pub(crate) struct Nir1EntryWitness {
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
                epoch_mirror: AtomicU64::new(0),
                poisoned_mirror: AtomicBool::new(false),
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
        self.shared.advance_epoch(&mut state);
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

    /// Open the exact Ready entry named by `proof`, after its sweep owner
    /// recorded a complete sweep and the supervisor observed the blocking
    /// task's successful Join. A proof from an older epoch or entry cannot
    /// open the gate; it is dropped and affects only its own entry.
    pub(crate) fn open_after_joined_sweep(&self, mut proof: Nir1SweepProof) -> bool {
        if !Arc::ptr_eq(&proof.shared, &self.shared) {
            return false;
        }
        let Ok(mut state) = self.shared.lock_state_checked() else {
            return false;
        };
        let exact = state.epoch == proof.epoch
            && matches!(
                &state.phase,
                Phase::Recovering { entry, swept: true } if Arc::ptr_eq(entry, &proof.entry)
            );
        if !exact || has_leases_through(&state, state.epoch) {
            // Release the gate mutex before the unused proof's Drop runs.
            drop(state);
            return false;
        }
        state.phase = Phase::Open(Arc::clone(&proof.entry));
        proof.used = true;
        true
    }

    /// Issue a lease only while the exact Ready entry is Open.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn try_lease(
        &self,
        binding: &LiveBinding,
        ready_revision: StateRevision,
    ) -> Option<Nir1StartupLease> {
        self.issue_lease(|entry, _epoch| entry.is(binding, ready_revision))
    }

    /// Issue a lease while the Open entry has this exact binding. Revision-only
    /// Core changes after the entry was published do not matter: they are not
    /// edges, and every edge closes the gate.
    pub(crate) fn try_lease_for_binding(&self, binding: &LiveBinding) -> Option<Nir1StartupLease> {
        self.issue_lease(|entry, _epoch| &entry.binding == binding)
    }

    /// Issue a lease only while the gate is still Open for the exact entry
    /// and epoch this witness was taken from (never a later entry, even with
    /// the same binding).
    pub(crate) fn try_lease_for_witness(
        &self,
        witness: &Nir1EntryWitness,
    ) -> Option<Nir1StartupLease> {
        if !Arc::ptr_eq(&witness.shared, &self.shared) {
            return None;
        }
        self.issue_lease(|entry, epoch| {
            epoch == witness.epoch && Arc::ptr_eq(entry, &witness.entry)
        })
    }

    fn issue_lease(
        &self,
        accept: impl FnOnce(&Arc<ReadyEntry>, u64) -> bool,
    ) -> Option<Nir1StartupLease> {
        let mut state = self.shared.lock_state_checked().ok()?;
        let epoch = state.epoch;
        let entry = match &state.phase {
            Phase::Open(entry) if accept(entry, epoch) => Arc::clone(entry),
            _ => return None,
        };
        let count = state.leases.entry(epoch).or_default();
        *count = count.checked_add(1)?;
        drop(state);
        Some(Nir1StartupLease {
            shared: Arc::clone(&self.shared),
            epoch,
            entry,
        })
    }

    /// The Ready entry named by the latest closure, if that closure is a
    /// Ready entry (awaiting, recovering or Open).
    pub(crate) fn current_ready_entry(&self) -> Option<(LiveBinding, StateRevision)> {
        let state = self.shared.lock_state();
        if state.poisoned || state.shutdown {
            return None;
        }
        match &state.closure {
            Closure::Ready(entry) => Some((entry.binding.clone(), entry.revision)),
            _ => None,
        }
    }

    /// No edge has replaced the exact Ready entry `(binding, revision)`.
    pub(crate) fn is_current_ready_entry(
        &self,
        binding: &LiveBinding,
        revision: StateRevision,
    ) -> bool {
        let state = self.shared.lock_state();
        !state.poisoned
            && !state.shutdown
            && matches!(&state.closure, Closure::Ready(entry) if entry.is(binding, revision))
    }

    /// Whether this gate can identify Ready entries at all. It cannot when it
    /// is poisoned or has never observed an edge (its observer registration
    /// failed); callers then fall back to the exact Core revision, and the
    /// gate stays Closed.
    pub(crate) fn observes_lifecycle(&self) -> bool {
        let state = self.shared.lock_state();
        !state.poisoned && !matches!(state.closure, Closure::Initial)
    }

    /// The epoch of the Open entry, if the gate is Open.
    pub(crate) fn open_entry_epoch(&self) -> Option<u64> {
        let state = self.shared.lock_state();
        match state.phase {
            Phase::Open(_) if !state.poisoned && !state.shutdown => Some(state.epoch),
            _ => None,
        }
    }

    /// The current closure epoch, read without the gate mutex.
    pub(crate) fn current_epoch(&self) -> u64 {
        self.shared.epoch_mirror.load(Ordering::Acquire)
    }

    /// Close the gate if it is still Open for the witness's exact entry, and
    /// consume that entry: it reopens only after a later Ready entry sweeps.
    pub(crate) fn quarantine_entry(&self, witness: &Nir1EntryWitness) -> bool {
        if !Arc::ptr_eq(&witness.shared, &self.shared) {
            return false;
        }
        let mut state = self.shared.lock_state();
        let exact = !state.poisoned
            && state.epoch == witness.epoch
            && matches!(&state.phase, Phase::Open(entry) if Arc::ptr_eq(entry, &witness.entry));
        if !exact {
            return false;
        }
        state.phase = Phase::Closed;
        state.closure = if state.shutdown {
            Closure::Shutdown
        } else {
            Closure::Consumed
        };
        self.shared.advance_epoch(&mut state);
        drop(state);
        self.shared.changed.notify_all();
        true
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

    /// Poison the gate mutex as a panicking holder would (test only).
    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let shared = Arc::clone(&self.shared);
        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _state = shared.state.lock().expect("unpoisoned gate");
            panic!("poison gate state");
        }));
        assert!(panic.is_err());
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
    /// without cutoff, cancel or error. Opening still waits for the Join:
    /// the returned proof travels through the task's JoinHandle.
    pub(crate) fn record_complete_sweep(mut self) -> Option<Nir1SweepProof> {
        let Ok(mut state) = self.shared.lock_state_checked() else {
            return None;
        };
        if state.epoch != self.epoch {
            return None;
        }
        match &mut state.phase {
            Phase::Recovering { entry, swept } if Arc::ptr_eq(entry, &self.entry) => {
                *swept = true;
                self.recorded = true;
                Some(Nir1SweepProof {
                    shared: Arc::clone(&self.shared),
                    epoch: self.epoch,
                    entry: Arc::clone(&self.entry),
                    used: false,
                })
            }
            _ => None,
        }
    }
}

impl Drop for Nir1StartupRecovery {
    fn drop(&mut self) {
        if !self.recorded {
            self.shared.consume_recovering(self.epoch, &self.entry);
        }
    }
}

impl Drop for Nir1SweepProof {
    fn drop(&mut self) {
        if !self.used {
            self.shared.consume_recovering(self.epoch, &self.entry);
        }
    }
}

impl Nir1StartupLease {
    /// Recheck after work: false once any closure has replaced the Open
    /// entry this lease was issued from. Reads atomics only, no lock.
    pub(crate) fn is_current(&self) -> bool {
        self.shared.is_current_at(self.epoch)
    }

    pub(crate) fn binding(&self) -> &LiveBinding {
        &self.entry.binding
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn entry_revision(&self) -> StateRevision {
        self.entry.revision
    }

    pub(crate) fn witness(&self) -> Nir1EntryWitness {
        Nir1EntryWitness {
            shared: Arc::clone(&self.shared),
            epoch: self.epoch,
            entry: Arc::clone(&self.entry),
        }
    }
}

impl Nir1EntryWitness {
    /// Same answer as the lease's `is_current`, without counting or locking.
    pub(crate) fn is_current(&self) -> bool {
        self.shared.is_current_at(self.epoch)
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
            self.fail_closed(&mut state);
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

    fn fail_closed(&self, state: &mut GateState) {
        state.poisoned = true;
        state.phase = Phase::Closed;
        self.poisoned_mirror.store(true, Ordering::Release);
    }

    /// Advance the closure epoch under the mutex; exhaustion poisons.
    fn advance_epoch(&self, state: &mut GateState) {
        match state.epoch.checked_add(1) {
            Some(epoch) => {
                state.epoch = epoch;
                self.epoch_mirror.store(epoch, Ordering::Release);
            }
            None => self.fail_closed(state),
        }
    }

    /// A lease or witness from epoch `epoch` was issued while its entry was
    /// Open, and Open is left only by an epoch advance or by poison. So the
    /// mirrors decide currency exactly as the mutex-guarded state would.
    fn is_current_at(&self, epoch: u64) -> bool {
        !self.state.is_poisoned()
            && !self.poisoned_mirror.load(Ordering::Acquire)
            && self.epoch_mirror.load(Ordering::Acquire) == epoch
    }

    /// Close and consume one exact Recovering entry, never a newer one.
    fn consume_recovering(&self, epoch: u64, entry: &Arc<ReadyEntry>) {
        let mut state = self.lock_state();
        if state.epoch == epoch
            && matches!(
                &state.phase,
                Phase::Recovering { entry: current, .. } if Arc::ptr_eq(current, entry)
            )
        {
            state.phase = Phase::Closed;
            state.closure = Closure::Consumed;
        }
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
                    self.fail_closed(&mut state);
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
        let proof = recovery.record_complete_sweep().expect("sweep proof");
        assert!(gate.open_after_joined_sweep(proof));
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
        let proof = recovery.record_complete_sweep().expect("sweep proof");
        assert!(gate.try_lease(&ready, 7).is_none(), "sweep without Join is closed");
        assert!(gate.open_after_joined_sweep(proof));

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
        let proof = recovery.record_complete_sweep().expect("sweep proof");
        assert!(gate.open_after_joined_sweep(proof));
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

        drop(prior);
        let current = gate
            .begin_recovery(&ready_c, 9, Duration::ZERO)
            .expect("current Ready entry");
        let proof = current.record_complete_sweep().expect("sweep proof");
        assert!(gate.open_after_joined_sweep(proof));
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
        assert!(
            stale.record_complete_sweep().is_none(),
            "A's sweep is for an old entry"
        );
        assert!(gate.is_closed());

        // Same binding, newer revision: still a different Ready entry.
        let recovery_b = gate
            .begin_recovery(&ready_b, 8, Duration::ZERO)
            .expect("B recovery");
        let proof_b8 = recovery_b.record_complete_sweep().expect("B proof");
        publish(&gate, &ready_b, 9);
        assert!(
            !gate.open_after_joined_sweep(proof_b8),
            "older entry's proof"
        );
        assert!(
            gate.awaits_recovery_for(&ready_b, 9),
            "stale proof Drop is inert"
        );
        let recovery_b9 = gate
            .begin_recovery(&ready_b, 9, Duration::ZERO)
            .expect("B revision 9 recovery");
        let proof_b9 = recovery_b9.record_complete_sweep().expect("B9 proof");
        assert!(gate.open_after_joined_sweep(proof_b9));
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

    /// G1: a lease is issued by binding even after revision-only Core changes
    /// (they are not edges); every edge closes the entry.
    #[test]
    fn g1_binding_lease_survives_revision_only_changes_and_closes_on_edges() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        assert!(
            gate.try_lease_for_binding(&ready).is_none(),
            "Closed issues none"
        );
        open(&gate, &ready, 7);
        // A revision-only change produces no edge; the claimant presents only
        // its binding and the lease keeps the entry revision.
        let lease = gate.try_lease_for_binding(&ready).expect("binding lease");
        assert_eq!(lease.binding(), &ready);
        assert_eq!(lease.entry_revision(), 7);
        assert!(gate.try_lease_for_binding(&binding(2, 1)).is_none());
        assert_eq!(gate.current_ready_entry(), Some((ready.clone(), 7)));
        assert!(gate.is_current_ready_entry(&ready, 7));
        assert!(!gate.is_current_ready_entry(&ready, 8));
        admit(&gate, 11);
        assert!(!lease.is_current());
        assert!(gate.try_lease_for_binding(&ready).is_none());
        assert!(gate.current_ready_entry().is_none());
        assert!(!gate.is_current_ready_entry(&ready, 7));
        drop(lease);
    }

    /// G2: the sweep proof is one-shot and opens only its own exact entry.
    #[test]
    fn g2_sweep_proof_is_one_shot_and_exact() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        publish(&gate, &ready, 7);
        let proof = gate
            .begin_recovery(&ready, 7, Duration::ZERO)
            .expect("recovery")
            .record_complete_sweep()
            .expect("proof");
        // Another gate cannot consume it.
        let other = Nir1StartupAdmissionGate::new();
        assert!(!other.open_after_joined_sweep(proof));
        assert!(gate.is_closed());
        assert!(
            gate.begin_recovery(&ready, 7, Duration::ZERO).is_none(),
            "the unused proof's Drop consumed its entry"
        );

        // A newer entry is never closed by an older proof's Drop.
        publish(&gate, &ready, 8);
        let stale = gate
            .begin_recovery(&ready, 8, Duration::ZERO)
            .expect("recovery 8")
            .record_complete_sweep()
            .expect("proof 8");
        publish(&gate, &ready, 9);
        drop(stale);
        assert!(gate.awaits_recovery_for(&ready, 9));
        let proof = gate
            .begin_recovery(&ready, 9, Duration::ZERO)
            .expect("recovery 9")
            .record_complete_sweep()
            .expect("proof 9");
        assert!(gate.open_after_joined_sweep(proof));
        assert!(gate.is_open_for(&ready, 9));
    }

    /// G3: quarantine closes the exact Open entry until a later Ready entry
    /// sweeps; a stale witness cannot quarantine a newer entry.
    #[test]
    fn g3_quarantine_closes_the_open_entry_until_the_next_sweep() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let lease = gate.try_lease_for_binding(&ready).expect("lease");
        let witness = lease.witness();
        let epoch = gate.epoch();
        assert_eq!(gate.open_entry_epoch(), Some(epoch));
        assert!(gate.quarantine_entry(&witness));
        assert_eq!(gate.epoch(), epoch + 1);
        assert!(gate.is_closed());
        assert!(gate.open_entry_epoch().is_none());
        assert!(!lease.is_current());
        assert!(!witness.is_current());
        assert!(gate.try_lease_for_binding(&ready).is_none());
        assert!(
            gate.begin_recovery(&ready, 7, Duration::ZERO).is_none(),
            "the quarantined entry is consumed"
        );
        assert!(!gate.quarantine_entry(&witness), "already closed");
        drop(lease);
        open(&gate, &ready, 8);
        assert!(!gate.quarantine_entry(&witness), "stale witness");
        assert!(gate.is_open_for(&ready, 8));
        assert!(gate.open_entry_epoch().is_some_and(|open| open > epoch + 1));
    }

    /// G4: lock-free currency equals the mutex-guarded state under close,
    /// quarantine, shutdown, epoch exhaustion and poison.
    #[test]
    fn g4_lock_free_currency_matches_the_guarded_state() {
        let guarded = |gate: &Nir1StartupAdmissionGate, lease: &Nir1StartupLease| {
            let state = gate.shared.lock_state();
            state.epoch == lease.epoch
                && matches!(&state.phase, Phase::Open(entry) if Arc::ptr_eq(entry, &lease.entry))
        };
        type Closer = fn(&Nir1StartupAdmissionGate, &Nir1EntryWitness);
        let closers: [(&str, Closer); 5] = [
            ("edge", |gate, _| admit(gate, 11)),
            ("quarantine", |gate, witness| {
                assert!(gate.quarantine_entry(witness));
            }),
            ("shutdown", |gate, _| gate.close_for_shutdown()),
            ("epoch exhaustion", |gate, _| {
                {
                    let mut state = gate.shared.lock_state();
                    state.epoch = u64::MAX;
                    gate.shared.epoch_mirror.store(u64::MAX, Ordering::Release);
                }
                admit(gate, 12);
            }),
            ("poison", |gate, _| gate.poison_for_test()),
        ];
        for (name, close) in closers {
            let gate = Nir1StartupAdmissionGate::new();
            let ready = binding(1, 1);
            open(&gate, &ready, 7);
            let lease = gate.try_lease_for_binding(&ready).expect("lease");
            let witness = lease.witness();
            assert!(lease.is_current() && witness.is_current() && guarded(&gate, &lease));
            if name == "epoch exhaustion" {
                // The forced epoch makes the earlier lease stale by itself.
                close(&gate, &witness);
                assert!(!lease.is_current() && !witness.is_current(), "{name}");
                assert!(!guarded(&gate, &lease), "{name}");
                continue;
            }
            close(&gate, &witness);
            assert_eq!(lease.is_current(), guarded(&gate, &lease), "{name}");
            assert!(!lease.is_current(), "{name}");
            assert!(!witness.is_current(), "{name}");
            drop(lease);
        }
    }

    /// G5: a witness re-leases only the same epoch and exact entry.
    #[test]
    fn g5_witness_lease_requires_the_same_open_entry_and_epoch() {
        let gate = Nir1StartupAdmissionGate::new();
        let ready = binding(1, 1);
        open(&gate, &ready, 7);
        let lease = gate.try_lease_for_binding(&ready).expect("lease");
        let witness = lease.witness();
        drop(lease);
        let again = gate.try_lease_for_witness(&witness).expect("same entry");
        assert!(again.is_current());
        drop(again);
        admit(&gate, 11);
        open(&gate, &ready, 8);
        assert!(
            gate.try_lease_for_binding(&ready).is_some(),
            "new same-binding entry"
        );
        assert!(
            gate.try_lease_for_witness(&witness).is_none(),
            "a witness never crosses into a later entry"
        );
        assert!(Nir1StartupAdmissionGate::new()
            .try_lease_for_witness(&witness)
            .is_none());
    }
}
