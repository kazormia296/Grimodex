//! LP-GATE (DR-CQD-GATE-1〜10): the Graph window gate.
//!
//! A held Related Scenes query (CQ-DEFER, D′) reads the main database at three
//! points: the S0 stamp and the worker's registration, the query, and the
//! join's live requalification. Any commit on the main connection between
//! them drifts the answer (DR-CQD-8, F10). The background incremental
//! Freshness cycle is such a committer, and nothing kept it out of the window
//! (CP-4 LP-D diagnosis: 22/22 lost displays overlapped one of its commits).
//!
//! This gate lets the two take turns, in process memory only:
//!
//! * Freshness enters once per cycle, before any of its work, and holds a
//!   *section* (RAII) until the cycle has returned. It waits while a window
//!   lease is live or the Graph is waiting to open one, at most
//!   `admit_wait` per call; then it is *deferred* (it touches no database)
//!   and holds the *turn* for `defer_turn`. After `ceiling` of waiting in a
//!   row it goes on regardless (`overridden`).
//! * The Graph owner opens a window (a lease, RAII, at most `lease_max` old)
//!   only while no section is in flight and Freshness does not hold the turn.
//!   It waits for that at most `graph_wait`; past it, it goes on without a
//!   window, exactly as before this gate (the drift checks stay).
//!
//! The mutex is a leaf: nothing else is locked under it and no callback runs
//! under it, so a lease or a section may be dropped under any other lock.
//! Time and waiting are injectable, so the state machine is tested without
//! sleeping. Nothing here is durable; a lifecycle edge or a close drops every
//! lease.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

/// A window lease stops counting this long after it was taken (DR-CQD-GATE-6).
pub(crate) const WINDOW_LEASE_MAX: Duration = Duration::from_millis(500);
/// The most one Freshness call waits before it is deferred (DR-CQD-GATE-5).
pub(crate) const FRESHNESS_ADMIT_WAIT: Duration = Duration::from_millis(250);
/// Freshness made to wait this long in a row goes on regardless.
pub(crate) const FRESHNESS_BLOCK_CEILING: Duration = Duration::from_secs(1);
/// The most the Graph waits for a section or the turn (DR-CQD-GATE-4).
pub(crate) const GRAPH_SECTION_WAIT: Duration = Duration::from_millis(100);
/// After a deferral, Freshness holds the turn this long (DR-CQD-GATE-5).
pub(crate) const FRESHNESS_DEFER_TURN: Duration = Duration::from_millis(50);
/// Every wait looks at the stop conditions at least this often.
pub(crate) const GATE_WAIT_STEP: Duration = Duration::from_millis(10);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GateLimits {
    pub(crate) lease_max: Duration,
    pub(crate) admit_wait: Duration,
    pub(crate) ceiling: Duration,
    pub(crate) graph_wait: Duration,
    pub(crate) defer_turn: Duration,
    pub(crate) step: Duration,
}

impl Default for GateLimits {
    fn default() -> Self {
        Self {
            lease_max: WINDOW_LEASE_MAX,
            admit_wait: FRESHNESS_ADMIT_WAIT,
            ceiling: FRESHNESS_BLOCK_CEILING,
            graph_wait: GRAPH_SECTION_WAIT,
            defer_turn: FRESHNESS_DEFER_TURN,
            step: GATE_WAIT_STEP,
        }
    }
}

/// The clock and the wait of the gate. The product uses the system clock and
/// the condition variable; a test advances a manual clock instead of waiting.
pub(crate) trait GateClock: Send + Sync {
    fn now(&self) -> Instant;
    fn wait<'a>(
        &self,
        changed: &Condvar,
        core: MutexGuard<'a, GateCore>,
        timeout: Duration,
    ) -> MutexGuard<'a, GateCore>;
}

struct SystemClock;

impl GateClock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn wait<'a>(
        &self,
        changed: &Condvar,
        core: MutexGuard<'a, GateCore>,
        timeout: Duration,
    ) -> MutexGuard<'a, GateCore> {
        changed
            .wait_timeout(core, timeout)
            .unwrap_or_else(PoisonError::into_inner)
            .0
    }
}

struct LeaseSlot {
    id: u64,
    deadline: Instant,
}

/// The gate's state. Every field changes under the gate's mutex only.
pub(crate) struct GateCore {
    /// Freshness sections in flight (the scheduler runs one at a time; a
    /// restore's own cycle may overlap it, so this is a count).
    sections: u32,
    /// Graph owners waiting to open a window.
    graph_waiters: u32,
    leases: Vec<LeaseSlot>,
    /// When Freshness was first made to wait since its last section.
    blocked_since: Option<Instant>,
    /// After a deferral: until then Freshness has the turn.
    turn_until: Option<Instant>,
    /// After a close (shutdown) no window opens again.
    closed: bool,
    next_id: u64,
}

impl GateCore {
    fn new() -> Self {
        Self {
            sections: 0,
            graph_waiters: 0,
            leases: Vec::new(),
            blocked_since: None,
            turn_until: None,
            closed: false,
            next_id: 1,
        }
    }

    /// Drops every lease past its deadline; returns how many.
    fn prune(&mut self, now: Instant) -> u64 {
        let before = self.leases.len();
        self.leases.retain(|lease| now < lease.deadline);
        (before - self.leases.len()) as u64
    }

    fn turn_active(&self, now: Instant) -> bool {
        self.turn_until.is_some_and(|until| now < until)
    }

    fn earliest_deadline(&self) -> Option<Instant> {
        self.leases.iter().map(|lease| lease.deadline).min()
    }

    fn take_section(&mut self) {
        self.sections = self.sections.saturating_add(1);
        self.blocked_since = None;
        self.turn_until = None;
    }

    fn end_streak(&mut self) {
        self.blocked_since = None;
        self.turn_until = None;
    }

    fn end_section(&mut self) {
        self.sections = self.sections.saturating_sub(1);
    }

    fn release_lease(&mut self, id: u64) {
        self.leases.retain(|lease| lease.id != id);
    }
}

/// Counters only: no strings and no identifiers (post-B §4.4).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct GateCounters {
    /// Freshness calls answered deferred (the turn was taken).
    pub(crate) deferred: u64,
    /// Freshness calls that waited and then entered within the call.
    pub(crate) waited_admit: u64,
    /// Freshness calls that went on past the ceiling.
    pub(crate) overridden: u64,
    /// Freshness calls stopped by the lifecycle while waiting.
    pub(crate) stopped: u64,
    /// Leases that stopped counting at their deadline.
    pub(crate) lease_expired: u64,
    pub(crate) windows_opened: u64,
    /// Windows opened after the Graph waited.
    pub(crate) graph_waited: u64,
    /// Graph waits past the budget: no window was opened.
    pub(crate) graph_wait_expired: u64,
}

#[derive(Default)]
struct AtomicCounters {
    deferred: AtomicU64,
    waited_admit: AtomicU64,
    overridden: AtomicU64,
    stopped: AtomicU64,
    lease_expired: AtomicU64,
    windows_opened: AtomicU64,
    graph_waited: AtomicU64,
    graph_wait_expired: AtomicU64,
}

fn bump(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

fn add(counter: &AtomicU64, value: u64) {
    if value != 0 {
        counter.fetch_add(value, Ordering::Relaxed);
    }
}

fn read(counter: &AtomicU64) -> u64 {
    counter.load(Ordering::Relaxed)
}

pub(crate) struct GraphCommitGate {
    core: Mutex<GateCore>,
    changed: Condvar,
    /// A leaf lock, read once at the start of a call. Tests install other
    /// values; the product keeps the constants.
    limits: Mutex<GateLimits>,
    clock: Box<dyn GateClock>,
    counters: AtomicCounters,
}

/// The answer to a Freshness call.
pub(crate) enum FreshnessAdmission {
    /// No window was live (at once or after waiting within the call).
    Admitted(FreshnessSection),
    /// Waited past the ceiling: goes on while a window may be live.
    Overridden(FreshnessSection),
    /// Waited `admit_wait` within this call: do no work, report a backlog.
    Deferred,
    /// The lifecycle stopped the wait (a switch, a shutdown).
    Stopped,
}

/// A Freshness cycle in flight. Dropping it (on every exit, an unwind
/// included) ends the section and wakes a waiting Graph.
pub(crate) struct FreshnessSection {
    gate: Arc<GraphCommitGate>,
}

impl Drop for FreshnessSection {
    fn drop(&mut self) {
        {
            let mut core = self.gate.lock();
            core.end_section();
        }
        self.gate.changed.notify_all();
    }
}

/// A Graph window. It travels with the answer (ticket → cache → the child's
/// join) and is dropped where the join is over or the answer is discarded.
pub(crate) struct WindowLease {
    gate: Arc<GraphCommitGate>,
    id: u64,
}

impl Drop for WindowLease {
    fn drop(&mut self) {
        {
            let mut core = self.gate.lock();
            core.release_lease(self.id);
        }
        self.gate.changed.notify_all();
    }
}

impl std::fmt::Debug for WindowLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WindowLease").field("id", &self.id).finish()
    }
}

impl GraphCommitGate {
    pub(crate) fn new() -> Arc<Self> {
        Self::with_clock(GateLimits::default(), Box::new(SystemClock))
    }

    pub(crate) fn with_clock(limits: GateLimits, clock: Box<dyn GateClock>) -> Arc<Self> {
        Arc::new(Self {
            core: Mutex::new(GateCore::new()),
            changed: Condvar::new(),
            limits: Mutex::new(limits),
            clock,
            counters: AtomicCounters::default(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, GateCore> {
        self.core.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn prune(&self, core: &mut GateCore, now: Instant) {
        add(&self.counters.lease_expired, core.prune(now));
    }

    /// Freshness's entry (DR-CQD-GATE-2, 5). Blocks the calling thread (never
    /// an async task) at most `admit_wait`. `stop` reads process atomics only;
    /// it is called under the gate's mutex.
    pub(crate) fn enter_freshness(self: &Arc<Self>, stop: impl Fn() -> bool) -> FreshnessAdmission {
        let limits = *self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        let started = self.clock.now();
        let mut waited = false;
        let mut core = self.lock();
        loop {
            let now = self.clock.now();
            self.prune(&mut core, now);
            // During its turn Freshness does not yield to a waiting Graph:
            // that Graph is waiting for this very Freshness to go first.
            if core.leases.is_empty() && (core.graph_waiters == 0 || core.turn_active(now)) {
                core.take_section();
                drop(core);
                if waited {
                    bump(&self.counters.waited_admit);
                }
                return FreshnessAdmission::Admitted(self.section());
            }
            let since = *core.blocked_since.get_or_insert(now);
            let blocked = now.saturating_duration_since(since);
            if blocked >= limits.ceiling {
                core.take_section();
                drop(core);
                bump(&self.counters.overridden);
                return FreshnessAdmission::Overridden(self.section());
            }
            if stop() {
                // A stopped wait ends the streak (review P2-1): the next
                // Freshness after a switch or a shutdown counts its ceiling
                // and holds a turn afresh. A deferral keeps both (it is the
                // streak the ceiling bounds).
                core.end_streak();
                drop(core);
                bump(&self.counters.stopped);
                return FreshnessAdmission::Stopped;
            }
            let in_call = now.saturating_duration_since(started);
            if in_call >= limits.admit_wait {
                core.turn_until = Some(now + limits.defer_turn);
                drop(core);
                bump(&self.counters.deferred);
                return FreshnessAdmission::Deferred;
            }
            waited = true;
            let mut timeout = limits
                .step
                .min(limits.admit_wait - in_call)
                .min(limits.ceiling - blocked);
            if let Some(deadline) = core.earliest_deadline() {
                timeout = timeout.min(deadline.saturating_duration_since(now));
            }
            core = self
                .clock
                .wait(&self.changed, core, timeout.max(Duration::from_micros(100)));
        }
    }

    fn section(self: &Arc<Self>) -> FreshnessSection {
        FreshnessSection {
            gate: Arc::clone(self),
        }
    }

    /// The Graph owner's entry (DR-CQD-GATE-3, 4), on the owner thread with
    /// no owner lock held. `wanted` is false once the held query is cancelled
    /// or the lifecycle epoch moved; it reads atomics only and is called
    /// under the gate's mutex, so an edge that invalidates every lease after
    /// this check also removes the lease taken here. None: no window (the
    /// query was abandoned, or the budget passed and it goes on without one).
    pub(crate) fn open_window(self: &Arc<Self>, wanted: impl Fn() -> bool) -> Option<WindowLease> {
        let limits = *self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        let started = self.clock.now();
        let mut waited = false;
        let mut core = self.lock();
        core.graph_waiters = core.graph_waiters.saturating_add(1);
        loop {
            let now = self.clock.now();
            self.prune(&mut core, now);
            if core.closed || !wanted() {
                core.graph_waiters = core.graph_waiters.saturating_sub(1);
                drop(core);
                self.changed.notify_all();
                return None;
            }
            if core.sections == 0 && !core.turn_active(now) {
                core.graph_waiters = core.graph_waiters.saturating_sub(1);
                let id = core.next_id;
                core.next_id = core.next_id.wrapping_add(1);
                core.leases.push(LeaseSlot {
                    id,
                    deadline: now + limits.lease_max,
                });
                drop(core);
                bump(&self.counters.windows_opened);
                if waited {
                    bump(&self.counters.graph_waited);
                }
                return Some(WindowLease {
                    gate: Arc::clone(self),
                    id,
                });
            }
            let elapsed = now.saturating_duration_since(started);
            if elapsed >= limits.graph_wait {
                core.graph_waiters = core.graph_waiters.saturating_sub(1);
                drop(core);
                // A Freshness that waited for this Graph may enter now.
                self.changed.notify_all();
                bump(&self.counters.graph_wait_expired);
                return None;
            }
            waited = true;
            let mut timeout = limits.step.min(limits.graph_wait - elapsed);
            if let Some(until) = core.turn_until.filter(|until| now < *until) {
                timeout = timeout.min(until.saturating_duration_since(now));
            }
            core = self
                .clock
                .wait(&self.changed, core, timeout.max(Duration::from_micros(100)));
        }
    }

    /// A lifecycle edge or a close: every live lease stops counting at once
    /// (each lease's own Drop then finds nothing to remove). After a close no
    /// window opens again.
    pub(crate) fn invalidate_all(&self, close: bool) {
        {
            let mut core = self.lock();
            core.leases.clear();
            // The windows Freshness was waiting for are gone: so is its streak
            // and its turn (review P2-1).
            core.end_streak();
            if close {
                core.closed = true;
            }
        }
        self.changed.notify_all();
    }

    pub(crate) fn counters(&self) -> GateCounters {
        let c = &self.counters;
        GateCounters {
            deferred: read(&c.deferred),
            waited_admit: read(&c.waited_admit),
            overridden: read(&c.overridden),
            stopped: read(&c.stopped),
            lease_expired: read(&c.lease_expired),
            windows_opened: read(&c.windows_opened),
            graph_waited: read(&c.graph_waited),
            graph_wait_expired: read(&c.graph_wait_expired),
        }
    }

    #[cfg(test)]
    pub(crate) fn graph_waiters_for_test(&self) -> u32 {
        self.lock().graph_waiters
    }

    /// True while a Freshness call has been made to wait since its last section.
    #[cfg(test)]
    pub(crate) fn freshness_blocked_for_test(&self) -> bool {
        self.lock().blocked_since.is_some()
    }

    #[cfg(test)]
    pub(crate) fn set_limits_for_test(&self, limits: GateLimits) {
        *self.limits.lock().unwrap_or_else(PoisonError::into_inner) = limits;
    }

    /// Live leases (not past their deadline) and sections in flight.
    #[cfg(test)]
    pub(crate) fn live_for_test(&self) -> (usize, u32) {
        let now = self.clock.now();
        let core = self.lock();
        (
            core.leases
                .iter()
                .filter(|lease| now < lease.deadline)
                .count(),
            core.sections,
        )
    }
}

#[cfg(test)]
#[path = "nir1_graph_commit_gate_tests.rs"]
mod tests;
