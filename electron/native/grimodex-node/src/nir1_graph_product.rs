//! CP-2a: the process-local C-query product owner for the NIR-1 Graph.
//!
//! Inert until PUB-G: `PRODUCT_GRAPH_PUBLISHED` is false and no product entry
//! reaches `begin`, so no worker starts and no Graph data leaves Native (A-1).
//! One slot holds at most one demand session; each session owns one thread
//! that prepares and queries the worker, so the worker never leaves the thread.
//! `begin` never waits on the database, a child process or a join.
#![cfg_attr(not(test), allow(dead_code))] // Still unused: the process worker (CP-2b), its path configuration, the Suspended resume hook (PUB-G/CP-4) and test-only inspection. CP-3a's callers are in related_scenes/graph.rs.

use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError},
        Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use anyhow::{anyhow, ensure, Result};
use grimodex_core::narrative_nir1::MAX_GRAPH_SCENES;
use grimodex_db::{
    narrative_extraction::{
        nir1_graph::{
            c_query_freshness::{try_read_c_query_freshness_stamp, CQueryFreshnessStamp},
            c_query_worker::{
                classify_c_query_failure, CQueryFailure, CQueryRetirement, CQueryWorkerOwner,
                REQUEST_BYTES,
            },
            worker_frame::{UnavailableCategory, UnavailableReason},
            worker_projection::Nir1GraphProjection,
        },
        Nir1GraphRequest,
    },
    state::{active_database, active_workspace_snapshot, ActiveWorkspaceSnapshot},
    workspace_lifecycle::{
        LifecycleEdge, LifecycleState, LiveBinding, WorkspaceLifecycleCore,
        WorkspaceLifecycleObserver,
    },
};

use crate::nir1_graph_dfinal::GraphWaitPlan;
use crate::state::AppState;

#[cfg(test)]
#[path = "nir1_graph_product_tests.rs"]
mod tests;

pub(crate) const NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE: &str = "nir1-graph-restart-required";

/// PUB-G flips this after Session C-1. Until then no product path can enable
/// the owner, start a worker, or return Graph data (A-1).
const PRODUCT_GRAPH_PUBLISHED: bool = false;
const _: () = assert!(!PRODUCT_GRAPH_PUBLISHED);

const OWNER_THREAD_NAME: &str = "nir1-graph-owner";
const COMMAND_CAPACITY: usize = 8;
const UNAVAILABLE_KINDS: usize = 14;
/// Most distinct projects whose unserved demand is remembered for a graph-ready
/// notice. Past it the oldest is forgotten; that window waits for its own next query.
const MAX_UNSERVED_PROJECTS: usize = 8;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GraphOwnerConfig {
    pub(crate) idle_retire_after: Duration,
    pub(crate) rebuild_min_interval: Duration,
    pub(crate) failure_backoff_initial: Duration,
    pub(crate) failure_backoff_max: Duration,
    pub(crate) failures_before_suspend: u32,
    pub(crate) cache_ttl: Duration,
}

impl Default for GraphOwnerConfig {
    fn default() -> Self {
        Self {
            idle_retire_after: Duration::from_secs(120),
            rebuild_min_interval: Duration::from_secs(1),
            failure_backoff_initial: Duration::from_secs(2),
            failure_backoff_max: Duration::from_secs(60),
            failures_before_suspend: 5,
            cache_ttl: Duration::from_secs(30),
        }
    }
}

/// The closed set of reasons a Graph result can be unavailable (DSN §1.5).
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum GraphUnavailable {
    NotRequested,
    NotActivated,
    ProfileNotRestricted,
    Warming,
    Stale,
    Busy,
    Limit,
    Timeout,
    RegistrationUnavailable,
    Invalidated,
    Cancelled,
    RestartRequired,
    WorkerUnavailable,
    Failed,
}

impl GraphUnavailable {
    pub(crate) const ALL: [Self; UNAVAILABLE_KINDS] = [
        Self::NotRequested,
        Self::NotActivated,
        Self::ProfileNotRestricted,
        Self::Warming,
        Self::Stale,
        Self::Busy,
        Self::Limit,
        Self::Timeout,
        Self::RegistrationUnavailable,
        Self::Invalidated,
        Self::Cancelled,
        Self::RestartRequired,
        Self::WorkerUnavailable,
        Self::Failed,
    ];

    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::NotRequested => "not-requested",
            Self::NotActivated => "not-activated",
            Self::ProfileNotRestricted => "profile-not-restricted",
            Self::Warming => "warming",
            Self::Stale => "stale",
            Self::Busy => "busy",
            Self::Limit => "limit",
            Self::Timeout => "timeout",
            Self::RegistrationUnavailable => "registration-unavailable",
            Self::Invalidated => "invalidated",
            Self::Cancelled => "cancelled",
            Self::RestartRequired => "restart-required",
            Self::WorkerUnavailable => "worker-unavailable",
            Self::Failed => "failed",
        }
    }

    fn from_category(category: UnavailableCategory) -> Self {
        match category {
            UnavailableCategory::Limit => Self::Limit,
            UnavailableCategory::Timeout => Self::Timeout,
            UnavailableCategory::Stale => Self::Stale,
            UnavailableCategory::RegistrationUnavailable => Self::RegistrationUnavailable,
            UnavailableCategory::Invalidated => Self::Invalidated,
            UnavailableCategory::Cancelled => Self::Cancelled,
            UnavailableCategory::Failed => Self::Failed,
        }
    }

    fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Debug)]
pub(crate) struct GraphQuery {
    pub(crate) project_id: String,
    pub(crate) query_scene_id: String,
    pub(crate) seed_entity_id: String,
}

pub(crate) enum GraphBegin {
    /// The worker accepted the query. The ticket settles exactly once.
    Pending(GraphTicket),
    /// The single-entry next-query cache hit. The caller must re-verify it
    /// through DSN §2.3 before use; the cache is never authority.
    Cached(Arc<Nir1GraphProjection>),
    Unavailable(GraphUnavailable),
}

#[derive(Clone, Debug)]
pub(crate) enum GraphTicketOutcome {
    Available(Arc<Nir1GraphProjection>),
    Unavailable(GraphUnavailable),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphTicketUse {
    Used,
    Unused,
    Cancelled,
}

/// One settled-once Graph result. Dropping it unsettled counts as cancelled.
pub(crate) struct GraphTicket {
    shared: Arc<TicketShared>,
    finished: bool,
}

impl GraphTicket {
    pub(crate) fn poll(&self) -> Option<GraphTicketOutcome> {
        self.shared.poll()
    }

    /// Blocking wait for a thread that owns no async runtime.
    pub(crate) fn wait_timeout(&self, timeout: Duration) -> Option<GraphTicketOutcome> {
        self.shared.wait_timeout(timeout)
    }

    pub(crate) fn waiter(&self) -> GraphTicketWaiter {
        GraphTicketWaiter {
            shared: Arc::clone(&self.shared),
        }
    }

    pub(crate) fn resolved_after(&self) -> Option<Duration> {
        self.shared.resolved_after()
    }

    pub(crate) fn finish(mut self, use_: GraphTicketUse) {
        self.finished = true;
        self.shared.finish(use_);
    }
}

impl Drop for GraphTicket {
    fn drop(&mut self) {
        if !self.finished {
            self.shared.finish(GraphTicketUse::Cancelled);
        }
    }
}

/// Waiter for a `spawn_blocking` consumer. It cannot settle the ticket.
pub(crate) struct GraphTicketWaiter {
    shared: Arc<TicketShared>,
}

impl GraphTicketWaiter {
    pub(crate) fn wait_timeout(&self, timeout: Duration) -> Option<GraphTicketOutcome> {
        self.shared.wait_timeout(timeout)
    }
}

pub(crate) struct GraphReadyNotice {
    pub(crate) project_id: String,
}

pub(crate) type GraphReadyNotifier = Arc<dyn Fn(&GraphReadyNotice) + Send + Sync>;

/// Everything a worker needs at creation. The product owner never sends it
/// across a thread: the worker is created, prepared, and retired on one owner
/// thread.
pub(crate) struct GraphWorkerStart {
    pub(crate) snapshot: ActiveWorkspaceSnapshot,
    pub(crate) binding: LiveBinding,
    /// Fake workers observe binding loss through this; the product never reads it.
    pub(crate) core: WorkspaceLifecycleCore,
}

pub(crate) trait GraphWorkerFactory: Send + Sync {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker>;
}

pub(crate) trait GraphWorker {
    fn prepare(&mut self, project_id: &str) -> Result<()>;
    fn query(&mut self, request: &Nir1GraphRequest, cancel: &AtomicBool)
        -> Result<Nir1GraphProjection>;
    fn quarantined(&self) -> bool;
    fn retire(self: Box<Self>) -> CQueryRetirement;
}

/// The product worker factory: the validated absolute path of the packaged
/// `nir1-c-query-worker` binary. CP-2a never calls this from a product path.
pub(crate) struct ProcessGraphWorkerFactory {
    worker: PathBuf,
}

impl ProcessGraphWorkerFactory {
    pub(crate) fn from_path(path: PathBuf) -> Result<Self> {
        ensure!(path.is_absolute(), "NIR1_GRAPH_WORKER_PATH");
        ensure!(
            std::fs::metadata(&path)
                .map_err(|_| anyhow!("NIR1_GRAPH_WORKER_PATH"))?
                .is_file(),
            "NIR1_GRAPH_WORKER_PATH"
        );
        let expected = if cfg!(windows) {
            "nir1-c-query-worker.exe"
        } else {
            "nir1-c-query-worker"
        };
        ensure!(
            path.file_name().is_some_and(|name| name == expected),
            "NIR1_GRAPH_WORKER_PATH"
        );
        ensure!(
            path.parent().is_some_and(Path::is_absolute),
            "NIR1_GRAPH_WORKER_PATH"
        );
        Ok(Self { worker: path })
    }
}

impl GraphWorkerFactory for ProcessGraphWorkerFactory {
    fn create(&self, start: GraphWorkerStart) -> Box<dyn GraphWorker> {
        Box::new(ProcessGraphWorker(CQueryWorkerOwner::new(
            start.snapshot,
            self.worker.clone(),
        )))
    }
}

struct ProcessGraphWorker(CQueryWorkerOwner);

impl GraphWorker for ProcessGraphWorker {
    fn prepare(&mut self, project_id: &str) -> Result<()> {
        self.0.prepare(project_id)
    }

    fn query(
        &mut self,
        request: &Nir1GraphRequest,
        cancel: &AtomicBool,
    ) -> Result<Nir1GraphProjection> {
        self.0.query_projected(request, cancel)
    }

    fn quarantined(&self) -> bool {
        self.0.retirement() == CQueryRetirement::Quarantined
    }

    fn retire(self: Box<Self>) -> CQueryRetirement {
        let ProcessGraphWorker(owner) = *self;
        owner.retire()
    }
}

/// Counters only: no strings, paths, bindings or identifiers (post-B §4.4).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct GraphOwnerDiagnostics {
    pub(crate) begins: u64,
    pub(crate) pending: u64,
    pub(crate) cache_hits: u64,
    pub(crate) unavailable: [u64; UNAVAILABLE_KINDS],
    pub(crate) prepares_started: u64,
    pub(crate) prepares_ready: u64,
    pub(crate) prepare_failures: u64,
    pub(crate) stamp0_missing: u64,
    pub(crate) stamp_fresh: u64,
    pub(crate) stamp_stale: u64,
    pub(crate) stamp_unavailable: u64,
    pub(crate) drift_at_query: u64,
    pub(crate) retired_idle: u64,
    pub(crate) retired_edge: u64,
    pub(crate) quarantines: u64,
    pub(crate) late_cached: u64,
    pub(crate) scene_total_over_cap: u64,
    pub(crate) query_scene_associated: u64,
    pub(crate) panics: u64,
}

#[derive(Debug, Default)]
struct DiagnosticCounters {
    begins: AtomicU64,
    pending: AtomicU64,
    cache_hits: AtomicU64,
    unavailable: [AtomicU64; UNAVAILABLE_KINDS],
    prepares_started: AtomicU64,
    prepares_ready: AtomicU64,
    prepare_failures: AtomicU64,
    stamp0_missing: AtomicU64,
    stamp_fresh: AtomicU64,
    stamp_stale: AtomicU64,
    stamp_unavailable: AtomicU64,
    drift_at_query: AtomicU64,
    retired_idle: AtomicU64,
    retired_edge: AtomicU64,
    quarantines: AtomicU64,
    late_cached: AtomicU64,
    scene_total_over_cap: AtomicU64,
    query_scene_associated: AtomicU64,
    panics: AtomicU64,
}

fn bump(counter: &AtomicU64) {
    counter.fetch_add(1, Ordering::Relaxed);
}

fn read(counter: &AtomicU64) -> u64 {
    counter.load(Ordering::Relaxed)
}

/// Process-local state. Lock order: Core → slot; slot → cache and ticket → cache
/// are allowed; cache → slot and slot → Core are not. `unserved` is a leaf: it is
/// taken under the slot or a ticket and never around another lock.
struct Shared {
    slot: Mutex<SlotState>,
    edge_epoch: AtomicU64,
    ready_generation: AtomicU64,
    /// D-final's wait for a READY (DSN §1.3 E7, DR-DI1A-5). A generation that
    /// grows when a session reaches READY, when it ends (retired, failed,
    /// quarantined, closed), on a lifecycle edge and on close, so a waiter
    /// re-reads the slot instead of sleeping out its whole budget. It is a
    /// leaf lock: nothing else is taken while it is held.
    ready_signal: Mutex<u64>,
    ready_signal_changed: Condvar,
    closed: AtomicBool,
    observer_registered: AtomicBool,
    /// Projects whose demand was answered warming, stale or busy and has not yet
    /// met a READY for its key (DSN §3.4 (a)). Distinct and bounded.
    unserved: Mutex<Vec<String>>,
    /// Set under the cache lock together with the cache clear, and never reset:
    /// once quarantined, a late result can no longer refill the cache.
    quarantined: AtomicBool,
    next_thread_id: AtomicU64,
    worker: OnceLock<Arc<dyn GraphWorkerFactory>>,
    notifier: Mutex<Option<GraphReadyNotifier>>,
    cache: Mutex<Option<CacheEntry>>,
    config: Mutex<GraphOwnerConfig>,
    /// D-final's wait budget and step. The constants in production; a test
    /// installs shorter values.
    dfinal_wait: Mutex<GraphWaitPlan>,
    diagnostics: DiagnosticCounters,
    #[cfg(test)]
    publication_open_for_test: AtomicBool,
    /// CP-4 S1a: set only by `nir1_graph_eval::register` for the AppState the
    /// evaluation build's `Backend::new` made. The field does not exist in the
    /// product build.
    #[cfg(feature = "nir1-graph-eval")]
    publication_open_for_eval: AtomicBool,
}

impl Shared {
    fn new() -> Self {
        Self {
            slot: Mutex::new(SlotState {
                phase: Phase::Empty,
                session: None,
                rebuild: RebuildLedger::default(),
                exited: Vec::new(),
            }),
            edge_epoch: AtomicU64::new(0),
            ready_generation: AtomicU64::new(0),
            ready_signal: Mutex::new(0),
            ready_signal_changed: Condvar::new(),
            closed: AtomicBool::new(false),
            observer_registered: AtomicBool::new(false),
            unserved: Mutex::new(Vec::new()),
            quarantined: AtomicBool::new(false),
            next_thread_id: AtomicU64::new(1),
            worker: OnceLock::new(),
            notifier: Mutex::new(None),
            cache: Mutex::new(None),
            config: Mutex::new(GraphOwnerConfig::default()),
            dfinal_wait: Mutex::new(GraphWaitPlan::default()),
            diagnostics: DiagnosticCounters::default(),
            #[cfg(test)]
            publication_open_for_test: AtomicBool::new(false),
            #[cfg(feature = "nir1-graph-eval")]
            publication_open_for_eval: AtomicBool::new(false),
        }
    }

    fn publication_open(&self) -> bool {
        if PRODUCT_GRAPH_PUBLISHED {
            return true;
        }
        #[cfg(feature = "nir1-graph-eval")]
        if self.publication_open_for_eval.load(Ordering::SeqCst) {
            return true;
        }
        #[cfg(test)]
        {
            self.publication_open_for_test.load(Ordering::SeqCst)
        }
        #[cfg(not(test))]
        {
            false
        }
    }

    fn config(&self) -> GraphOwnerConfig {
        *lock(&self.config)
    }

    /// Announces that the slot changed in a way a D-final waiter should look
    /// at again. Called after the change is published, never under another lock
    /// of this owner that a waiter needs.
    fn signal_ready(&self) {
        {
            let mut generation = lock(&self.ready_signal);
            *generation = generation.wrapping_add(1);
        }
        self.ready_signal_changed.notify_all();
    }

    fn count_unavailable(&self, reason: GraphUnavailable) -> GraphBegin {
        bump(&self.diagnostics.unavailable[reason.index()]);
        GraphBegin::Unavailable(reason)
    }

    fn unserved(&self, reason: GraphUnavailable, project_id: &str) -> GraphBegin {
        self.mark_unserved(project_id);
        self.count_unavailable(reason)
    }

    /// Remembers that `project_id` was told to wait for a new READY.
    fn mark_unserved(&self, project_id: &str) {
        let mut unserved = lock(&self.unserved);
        if unserved.iter().any(|existing| existing == project_id) {
            return;
        }
        if unserved.len() == MAX_UNSERVED_PROJECTS {
            unserved.remove(0);
        }
        unserved.push(project_id.to_owned());
    }

    /// True, once, when `project_id` was waiting: a READY for its key serves it.
    fn take_unserved(&self, project_id: &str) -> bool {
        let mut unserved = lock(&self.unserved);
        match unserved.iter().position(|existing| existing == project_id) {
            Some(index) => {
                unserved.remove(index);
                true
            }
            None => false,
        }
    }

    fn take_usable_cache(
        &self,
        key: &CacheKey,
        edge_epoch: u64,
        now: Instant,
        ttl: Duration,
    ) -> Option<Arc<Nir1GraphProjection>> {
        let mut cache = lock(&self.cache);
        if self.quarantined.load(Ordering::SeqCst) {
            *cache = None;
            return None;
        }
        match cache.as_ref() {
            Some(entry) if cache_entry_usable(entry, key, edge_epoch, now, ttl) => {
                let projection = Arc::clone(&entry.projection);
                *cache = None;
                Some(projection)
            }
            Some(_) => {
                *cache = None;
                None
            }
            None => None,
        }
    }

    fn store_late_cache(&self, key: &CacheKey, edge_epoch: u64, projection: Arc<Nir1GraphProjection>) {
        {
            let mut cache = lock(&self.cache);
            if self.quarantined.load(Ordering::SeqCst) {
                return;
            }
            *cache = Some(CacheEntry {
                key: key.clone(),
                projection,
                stored_at: Instant::now(),
                edge_epoch,
            });
        }
        bump(&self.diagnostics.late_cached);
        self.notify_ready(&key.project_id);
    }

    /// Announces a late result or a READY. The notifier runs outside every lock
    /// of this owner: it reaches the event queue.
    fn notify_ready(&self, project_id: &str) {
        let notifier = lock(&self.notifier).clone();
        if let Some(notifier) = notifier {
            notifier(&GraphReadyNotice {
                project_id: project_id.to_owned(),
            });
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.edge_epoch.fetch_add(1, Ordering::SeqCst);
        {
            let mut slot = lock(&self.slot);
            if let Some(session) = slot.session.as_ref() {
                let _ = session.commands.try_send(Command::Wake);
            } else if !matches!(slot.phase, Phase::Quarantined { .. }) {
                slot.phase = Phase::Closed;
            }
        }
        self.signal_ready();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GraphKey {
    binding: LiveBinding,
    project_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CacheKey {
    binding: LiveBinding,
    caller_epoch: u64,
    project_id: String,
    query_scene_id: String,
    seed_entity_id: String,
}

struct CacheEntry {
    key: CacheKey,
    projection: Arc<Nir1GraphProjection>,
    stored_at: Instant,
    edge_epoch: u64,
}

struct SlotState {
    phase: Phase,
    session: Option<Session>,
    rebuild: RebuildLedger,
    exited: Vec<JoinHandle<()>>,
}

#[derive(Clone, Debug)]
enum Phase {
    Empty,
    Preparing,
    Ready,
    InUse,
    Retiring,
    Suspended {
        ready_generation: u64,
        reason: GraphUnavailable,
    },
    Quarantined {
        binding: LiveBinding,
    },
    Closed,
}

/// Test-visible projection of the slot phase.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphSlotKind {
    Empty,
    Preparing,
    Ready,
    InUse,
    Retiring,
    Suspended,
    Quarantined,
    Closed,
}

struct Session {
    thread_id: u64,
    key: GraphKey,
    epoch: u64,
    last_demand: Instant,
    commands: SyncSender<Command>,
    join: Option<JoinHandle<()>>,
    pending_rekey: Option<PendingRekey>,
}

/// The other key a READY session is asked to rekey to, and when that demand
/// arrived. The rekeyed session's idle window runs from that demand.
struct PendingRekey {
    key: GraphKey,
    demand_at: Instant,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct RebuildLedger {
    pub(crate) last_prepare_started: Option<Instant>,
    pub(crate) consecutive_failures: u32,
    pub(crate) last_failure_at: Option<Instant>,
    pub(crate) last_failure: Option<GraphUnavailable>,
}

enum Command {
    Query {
        request: Nir1GraphRequest,
        ticket: Arc<TicketShared>,
    },
    Retire,
    Wake,
}

struct TicketShared {
    state: Mutex<TicketState>,
    resolved: Condvar,
    cancel: AtomicBool,
    cache_key: CacheKey,
    edge_epoch: u64,
    begun_at: Instant,
    owner: Arc<Shared>,
    /// CP-4 S1a: the stamp attempt and the Busy cause of this ticket.
    #[cfg(feature = "nir1-graph-eval")]
    eval_notes: crate::nir1_graph_eval::TicketNotes,
}

struct TicketState {
    outcome: Option<(GraphTicketOutcome, Instant)>,
    disposition: Option<GraphTicketUse>,
}

impl TicketShared {
    fn new(owner: Arc<Shared>, cache_key: CacheKey, edge_epoch: u64) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(TicketState {
                outcome: None,
                disposition: None,
            }),
            resolved: Condvar::new(),
            cancel: AtomicBool::new(false),
            cache_key,
            edge_epoch,
            begun_at: Instant::now(),
            owner,
            #[cfg(feature = "nir1-graph-eval")]
            eval_notes: crate::nir1_graph_eval::TicketNotes::default(),
        })
    }

    fn cacheable(&self) -> bool {
        self.owner.edge_epoch.load(Ordering::SeqCst) == self.edge_epoch
            && !self.owner.closed.load(Ordering::SeqCst)
            && !self.cancel.load(Ordering::SeqCst)
    }

    /// First outcome wins. A late Available result of an unused ticket fills
    /// the single-entry cache and fires the notifier once.
    fn deliver(&self, outcome: GraphTicketOutcome) {
        let mut candidate = None;
        {
            let mut state = lock(&self.state);
            if state.outcome.is_some() {
                return;
            }
            if let GraphTicketOutcome::Available(projection) = &outcome {
                if state.disposition == Some(GraphTicketUse::Unused) && self.cacheable() {
                    candidate = Some(Arc::clone(projection));
                }
            }
            // A stale or busy answer leaves the demand unserved, exactly as a
            // warming one does: the next READY for this key must be announced.
            if matches!(
                outcome,
                GraphTicketOutcome::Unavailable(GraphUnavailable::Stale | GraphUnavailable::Busy)
            ) {
                self.owner.mark_unserved(&self.cache_key.project_id);
            }
            state.outcome = Some((outcome, Instant::now()));
        }
        self.resolved.notify_all();
        if let Some(projection) = candidate {
            self.owner
                .store_late_cache(&self.cache_key, self.edge_epoch, projection);
        }
    }

    fn finish(&self, use_: GraphTicketUse) {
        let mut candidate = None;
        {
            let mut state = lock(&self.state);
            if state.disposition.is_some() {
                return;
            }
            state.disposition = Some(use_);
            match use_ {
                GraphTicketUse::Cancelled => {
                    self.cancel.store(true, Ordering::SeqCst);
                    state.outcome = Some((
                        GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled),
                        Instant::now(),
                    ));
                }
                GraphTicketUse::Unused => {
                    if let Some((GraphTicketOutcome::Available(projection), _)) = &state.outcome {
                        if self.cacheable() {
                            candidate = Some(Arc::clone(projection));
                        }
                    }
                }
                GraphTicketUse::Used => {}
            }
        }
        self.resolved.notify_all();
        if let Some(projection) = candidate {
            self.owner
                .store_late_cache(&self.cache_key, self.edge_epoch, projection);
        }
    }

    fn poll(&self) -> Option<GraphTicketOutcome> {
        lock(&self.state).outcome.as_ref().map(|(outcome, _)| outcome.clone())
    }

    fn wait_timeout(&self, timeout: Duration) -> Option<GraphTicketOutcome> {
        let deadline = Instant::now() + timeout;
        let mut state = lock(&self.state);
        loop {
            if let Some((outcome, _)) = state.outcome.as_ref() {
                return Some(outcome.clone());
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let (next, _) = self
                .resolved
                .wait_timeout(state, deadline - now)
                .unwrap_or_else(PoisonError::into_inner);
            state = next;
        }
    }

    fn resolved_after(&self) -> Option<Duration> {
        lock(&self.state)
            .outcome
            .as_ref()
            .map(|(_, at)| at.saturating_duration_since(self.begun_at))
    }
}

struct GraphEdgeObserver {
    shared: Arc<Shared>,
}

impl WorkspaceLifecycleObserver for GraphEdgeObserver {
    fn on_lifecycle_edge(&self, edge: &LifecycleEdge) {
        self.shared.edge_epoch.fetch_add(1, Ordering::SeqCst);
        match edge {
            LifecycleEdge::ReadyPublished { .. } => {
                self.shared.ready_generation.fetch_add(1, Ordering::SeqCst);
            }
            LifecycleEdge::ShutdownRequested { .. } => {
                self.shared.closed.store(true, Ordering::SeqCst);
            }
            // Transitions, unavailability and future edges retire by epoch only.
            _ => {}
        }
        {
            let slot = lock(&self.shared.slot);
            if let Some(session) = slot.session.as_ref() {
                let _ = session.commands.try_send(Command::Wake);
            }
        }
        // A waiter of D-final compares the edge epoch it started with.
        self.shared.signal_ready();
    }
}

/// The product owner held by AppState. Its Drop closes the owner.
pub(crate) struct Nir1GraphProductOwner {
    shared: Arc<Shared>,
}

impl Nir1GraphProductOwner {
    pub(crate) fn new(core: &WorkspaceLifecycleCore) -> Self {
        let shared = Arc::new(Shared::new());
        let registered = core
            .register_observer(Arc::new(GraphEdgeObserver {
                shared: Arc::clone(&shared),
            }))
            .is_ok();
        if !registered {
            tracing::warn!("nir1 graph owner lifecycle observer was not registered");
        }
        shared.observer_registered.store(registered, Ordering::SeqCst);
        Self { shared }
    }

    /// Wait-free admission. Every refusal names its reason; nothing is awaited.
    pub(crate) fn begin(&self, state: &Arc<AppState>, query: GraphQuery) -> GraphBegin {
        #[cfg(feature = "nir1-graph-eval")]
        let eval_probe = crate::nir1_graph_eval::BeginProbe::start(self);
        let result = self.admit(state, query);
        #[cfg(feature = "nir1-graph-eval")]
        eval_probe.finish(&result);
        result
    }

    fn admit(&self, state: &Arc<AppState>, query: GraphQuery) -> GraphBegin {
        let shared = &self.shared;
        bump(&shared.diagnostics.begins);
        if query.seed_entity_id.is_empty() {
            return shared.count_unavailable(GraphUnavailable::NotRequested);
        }
        if query.project_id.is_empty() || query.query_scene_id.is_empty() {
            return shared.count_unavailable(GraphUnavailable::Failed);
        }
        let request_bytes = 2usize
            .saturating_add(2 + query.project_id.len())
            .saturating_add(2 + query.query_scene_id.len())
            .saturating_add(2 + query.seed_entity_id.len());
        if request_bytes > REQUEST_BYTES {
            return shared.count_unavailable(GraphUnavailable::Limit);
        }
        if shared.closed.load(Ordering::SeqCst) {
            return shared.count_unavailable(GraphUnavailable::Invalidated);
        }
        if !shared.observer_registered.load(Ordering::SeqCst) || !shared.publication_open() {
            return shared.count_unavailable(GraphUnavailable::NotActivated);
        }
        let status = state.profile_egress.status();
        if !(status.restricted && status.in_flight_stopped) {
            return shared.count_unavailable(GraphUnavailable::ProfileNotRestricted);
        }
        let Some(factory) = shared.worker.get().cloned() else {
            return shared.count_unavailable(GraphUnavailable::WorkerUnavailable);
        };
        // Read Core before taking the slot: slot → Core is not an allowed order.
        let Some(binding) = ready_binding(state) else {
            return shared.count_unavailable(GraphUnavailable::Invalidated);
        };
        let epoch = shared.edge_epoch.load(Ordering::SeqCst);
        let now = Instant::now();
        let cache_key = CacheKey {
            binding: binding.clone(),
            caller_epoch: status.caller_epoch,
            project_id: query.project_id.clone(),
            query_scene_id: query.query_scene_id.clone(),
            seed_entity_id: query.seed_entity_id.clone(),
        };
        let config = shared.config();
        if let Some(projection) =
            shared.take_usable_cache(&cache_key, epoch, now, config.cache_ttl)
        {
            bump(&shared.diagnostics.cache_hits);
            return GraphBegin::Cached(projection);
        }
        let key = GraphKey {
            binding,
            project_id: query.project_id.clone(),
        };
        // Owned copies sized to their length: the worker bounds buffer capacity.
        let request = Nir1GraphRequest {
            project_id: query.project_id.as_str().to_owned(),
            query_scene_id: query.query_scene_id.as_str().to_owned(),
            seed_entity_id: query.seed_entity_id.as_str().to_owned(),
        };
        let demand = Demand {
            key,
            request,
            cache_key,
            epoch,
            now,
            factory,
        };
        let (result, finished) = shared.demand(state, demand, config);
        for handle in finished {
            let _ = handle.join();
        }
        if matches!(result, GraphBegin::Pending(_)) {
            bump(&shared.diagnostics.pending);
        }
        result
    }

    // ---- D-final's wait (DI-1a, DR-DI1A-5) ---------------------------------

    /// True once the publication gate is open. D-final asks it before it reads
    /// a seed, so a closed product costs nothing.
    pub(crate) fn publication_is_open(&self) -> bool {
        self.shared.publication_open()
    }

    /// The generation of the READY signal. A waiter reads it before `begin`, so
    /// a READY that lands between the `begin` and the wait is not lost.
    pub(crate) fn ready_signal_generation(&self) -> u64 {
        *lock(&self.shared.ready_signal)
    }

    /// Blocks the calling thread (never an async task) until the READY signal
    /// moves past `since` or `timeout` passes. True when it moved. The caller
    /// holds no database, lifecycle or profile lock.
    pub(crate) fn wait_ready_signal(&self, since: u64, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut generation = lock(&self.shared.ready_signal);
        loop {
            if *generation != since {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (next, _) = self
                .shared
                .ready_signal_changed
                .wait_timeout(generation, deadline - now)
                .unwrap_or_else(PoisonError::into_inner);
            generation = next;
        }
    }

    /// The lifecycle edge epoch. A D-final wait ends when it differs from the
    /// value read at the start (a transition, an unavailability, a shutdown).
    pub(crate) fn edge_epoch(&self) -> u64 {
        self.shared.edge_epoch.load(Ordering::SeqCst)
    }

    pub(crate) fn dfinal_wait_plan(&self) -> GraphWaitPlan {
        *lock(&self.shared.dfinal_wait)
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }

    /// CP-2a keeps this unused by products (the wiring is CP-2b / PUB-G).
    pub(crate) fn configure_worker_path(&self, path: PathBuf) -> Result<()> {
        let factory = ProcessGraphWorkerFactory::from_path(path)?;
        self.shared
            .worker
            .set(Arc::new(factory))
            .map_err(|_| anyhow!("NIR1_GRAPH_WORKER_ALREADY_CONFIGURED"))
    }

    /// `AppState` connects this to the EventQueue once (CP-3a). A second call is
    /// refused; under test it replaces the connection, so a test can observe
    /// the notices without the real queue.
    pub(crate) fn set_graph_ready_notifier(&self, notifier: GraphReadyNotifier) -> bool {
        let mut slot = lock(&self.shared.notifier);
        if slot.is_some() && !cfg!(test) {
            return false;
        }
        *slot = Some(notifier);
        true
    }

    /// Called after B's publish (B-ROUTE/CP-3a) to leave Suspended.
    pub(crate) fn resume_after_graph_index_change(&self) {
        let mut slot = lock(&self.shared.slot);
        if matches!(slot.phase, Phase::Suspended { .. }) {
            slot.phase = Phase::Empty;
            slot.rebuild.consecutive_failures = 0;
            slot.rebuild.last_failure = None;
        }
    }

    pub(crate) fn close_for_shutdown(&self) {
        self.shared.close();
    }

    pub(crate) fn is_quarantined(&self) -> bool {
        matches!(lock(&self.shared.slot).phase, Phase::Quarantined { .. })
    }

    /// What the quarantine left in Core, read from Core's own record first: the
    /// fence exists from the moment it is taken, before the owner thread has
    /// published the slot as Quarantined. A quarantined slot without a fence
    /// means the participant was kept (or everything was forgotten) instead.
    fn quarantine_hold(&self, state: &AppState) -> Option<QuarantineHold> {
        if let Ok(Some(binding)) = state.ws.lifecycle_core().c_query_quarantine_binding() {
            return Some(QuarantineHold::Fence(binding));
        }
        match lock(&self.shared.slot).phase {
            Phase::Quarantined { .. } => Some(QuarantineHold::Participant),
            _ => None,
        }
    }

    /// Restore is refused at the entry whenever Core would wait for it for the
    /// rest of the process. With a fence that is the workspace whose exact
    /// binding is quarantined; with a retained participant (no fence) it is every
    /// Restore, because no physical exclusion can be taken any more. Core's own
    /// rules are unchanged.
    pub(crate) fn blocks_restore_of_current_workspace(&self, state: &AppState) -> bool {
        match self.quarantine_hold(state) {
            None => false,
            Some(QuarantineHold::Participant) => true,
            Some(QuarantineHold::Fence(quarantined)) => {
                let Some(current) = ready_binding(state) else {
                    return false;
                };
                quarantined.locator == current.locator
                    || quarantined.workspace_id == current.workspace_id
                    || quarantined.same_main_database_file(&current)
            }
        }
    }

    /// A quarantine that kept its participant leaves Core no fence to refuse
    /// with, yet no Open can ever take physical exclusion again. Refuse every
    /// Open here, whatever its target, with Core's not-admitted wire shape. A
    /// fence keeps Core's own refusal (see `relabel_open_refusal`). An Open that
    /// Core admitted before the participant was kept cannot be recalled here:
    /// Core vetoes such a transition only for a fence.
    pub(crate) fn refuse_open_while_participant_quarantined(
        &self,
        state: &AppState,
    ) -> Option<String> {
        if !matches!(
            self.quarantine_hold(state),
            Some(QuarantineHold::Participant)
        ) {
            return None;
        }
        let snapshot = state.ws.lifecycle_core().snapshot().ok()?;
        Some(
            serde_json::json!({
                "status": "not-admitted",
                "reasonCode": NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE,
                "snapshot": crate::lifecycle_snapshot_wire(&snapshot),
            })
            .to_string(),
        )
    }

    /// Only an Open refused with `active-operation` for a quarantined target
    /// changes its reason code; the status and snapshot are kept.
    pub(crate) fn relabel_open_refusal(
        &self,
        wire: String,
        locator: &str,
        workspace_id: Option<&str>,
        database_file_identity: Option<&str>,
    ) -> String {
        let quarantined = match &lock(&self.shared.slot).phase {
            Phase::Quarantined { binding } => binding.clone(),
            _ => return wire,
        };
        if !quarantine_conflicts(&quarantined, locator, workspace_id, database_file_identity) {
            return wire;
        }
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&wire) else {
            return wire;
        };
        if value.get("reasonCode").and_then(serde_json::Value::as_str) != Some("active-operation") {
            return wire;
        }
        value["reasonCode"] = serde_json::Value::from(NIR1_GRAPH_RESTART_REQUIRED_REASON_CODE);
        serde_json::to_string(&value).unwrap_or(wire)
    }

    pub(crate) fn diagnostics(&self) -> GraphOwnerDiagnostics {
        let d = &self.shared.diagnostics;
        GraphOwnerDiagnostics {
            begins: read(&d.begins),
            pending: read(&d.pending),
            cache_hits: read(&d.cache_hits),
            unavailable: std::array::from_fn(|index| read(&d.unavailable[index])),
            prepares_started: read(&d.prepares_started),
            prepares_ready: read(&d.prepares_ready),
            prepare_failures: read(&d.prepare_failures),
            stamp0_missing: read(&d.stamp0_missing),
            stamp_fresh: read(&d.stamp_fresh),
            stamp_stale: read(&d.stamp_stale),
            stamp_unavailable: read(&d.stamp_unavailable),
            drift_at_query: read(&d.drift_at_query),
            retired_idle: read(&d.retired_idle),
            retired_edge: read(&d.retired_edge),
            quarantines: read(&d.quarantines),
            late_cached: read(&d.late_cached),
            scene_total_over_cap: read(&d.scene_total_over_cap),
            query_scene_associated: read(&d.query_scene_associated),
            panics: read(&d.panics),
        }
    }

    // ---- Test-only seams -------------------------------------------------
    #[cfg(test)]
    pub(crate) fn open_publication_for_test(&self) {
        self.shared
            .publication_open_for_test
            .store(true, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub(crate) fn install_worker_factory_for_test(&self, factory: Arc<dyn GraphWorkerFactory>) {
        let _ = self.shared.worker.set(factory);
    }

    #[cfg(test)]
    pub(crate) fn set_dfinal_wait_for_test(&self, plan: GraphWaitPlan) {
        *lock(&self.shared.dfinal_wait) = plan;
    }

    #[cfg(test)]
    pub(crate) fn set_config_for_test(&self, config: GraphOwnerConfig) {
        *lock(&self.shared.config) = config;
    }

    #[cfg(test)]
    pub(crate) fn slot_kind_for_test(&self) -> GraphSlotKind {
        self.slot_kind()
    }

    #[cfg(any(test, feature = "nir1-graph-eval"))]
    fn slot_kind(&self) -> GraphSlotKind {
        match lock(&self.shared.slot).phase {
            Phase::Empty => GraphSlotKind::Empty,
            Phase::Preparing => GraphSlotKind::Preparing,
            Phase::Ready => GraphSlotKind::Ready,
            Phase::InUse => GraphSlotKind::InUse,
            Phase::Retiring => GraphSlotKind::Retiring,
            Phase::Suspended { .. } => GraphSlotKind::Suspended,
            Phase::Quarantined { .. } => GraphSlotKind::Quarantined,
            Phase::Closed => GraphSlotKind::Closed,
        }
    }

    #[cfg(test)]
    pub(crate) fn edge_observer_for_test(&self) -> Arc<dyn WorkspaceLifecycleObserver> {
        Arc::new(GraphEdgeObserver {
            shared: Arc::clone(&self.shared),
        })
    }

    #[cfg(test)]
    pub(crate) fn cache_len_for_test(&self) -> usize {
        usize::from(lock(&self.shared.cache).is_some())
    }
}

impl Drop for Nir1GraphProductOwner {
    fn drop(&mut self) {
        self.shared.close();
    }
}

/// CP-4 S1a: what the evaluation module (`nir1_graph_eval`) may do to an owner.
/// None of it exists in the product build, and none of it changes a rule of the
/// owner: the publication flag is the only gate it opens, and only for the
/// owner of the AppState the evaluation build's `Backend::new` registered.
#[cfg(feature = "nir1-graph-eval")]
impl Nir1GraphProductOwner {
    pub(crate) fn open_publication_for_eval(&self) {
        self.shared
            .publication_open_for_eval
            .store(true, Ordering::SeqCst);
    }

    pub(crate) fn publication_open_for_eval(&self) -> bool {
        self.shared.publication_open_for_eval.load(Ordering::SeqCst)
    }

    /// Empties the single-entry next-query cache, as K6/2 (a) asks before each
    /// sample. True when an entry was there.
    pub(crate) fn clear_next_query_cache_for_eval(&self) -> bool {
        lock(&self.shared.cache).take().is_some()
    }

    pub(crate) fn cache_occupied_for_eval(&self) -> bool {
        lock(&self.shared.cache).is_some()
    }

    pub(crate) fn worker_configured_for_eval(&self) -> bool {
        self.shared.worker.get().is_some()
    }

    pub(crate) fn slot_kind_for_eval(&self) -> GraphSlotKind {
        self.slot_kind()
    }

    pub(crate) fn prepares_ready_for_eval(&self) -> u64 {
        read(&self.shared.diagnostics.prepares_ready)
    }
}

/// CP-4 S1a: the evaluation record reads when a ticket settled. It never
/// settles or declares one.
#[cfg(feature = "nir1-graph-eval")]
impl GraphTicketWaiter {
    pub(crate) fn begun_at_for_eval(&self) -> Instant {
        self.shared.begun_at
    }

    pub(crate) fn notes_for_eval(&self) -> crate::nir1_graph_eval::TicketNoteSnapshot {
        self.shared.eval_notes.snapshot()
    }

    pub(crate) fn settlement_for_eval(
        &self,
    ) -> Option<(Instant, Option<GraphUnavailable>, Option<GraphTicketUse>)> {
        let state = lock(&self.shared.state);
        let disposition = state.disposition;
        state.outcome.as_ref().map(|(outcome, at)| {
            let reason = match outcome {
                GraphTicketOutcome::Available(_) => None,
                GraphTicketOutcome::Unavailable(reason) => Some(*reason),
            };
            (*at, reason, disposition)
        })
    }
}

/// What a quarantine leaves in Core; it decides what the entries may admit.
enum QuarantineHold {
    /// A process-lifetime fence blocks only the quarantined workspace.
    Fence(LiveBinding),
    /// The participant was retained and no fence exists: no transition can finish.
    Participant,
}

struct Demand {
    key: GraphKey,
    request: Nir1GraphRequest,
    cache_key: CacheKey,
    epoch: u64,
    now: Instant,
    factory: Arc<dyn GraphWorkerFactory>,
}

impl Shared {
    /// The slot transition table of DSN §1.2. Returns the immediate result and
    /// any finished owner-thread handles to join outside the slot lock.
    fn demand(
        self: &Arc<Self>,
        state: &Arc<AppState>,
        demand: Demand,
        config: GraphOwnerConfig,
    ) -> (GraphBegin, Vec<JoinHandle<()>>) {
        let mut slot = lock(&self.slot);
        let finished = take_finished(&mut slot.exited);
        let phase = slot.phase.clone();
        let result = match phase {
            Phase::Closed => self.count_unavailable(GraphUnavailable::Invalidated),
            Phase::Quarantined { .. } => self.count_unavailable(GraphUnavailable::RestartRequired),
            Phase::Suspended {
                ready_generation,
                reason,
            } => {
                if ready_generation == self.ready_generation.load(Ordering::SeqCst) {
                    self.unserved(reason, &demand.key.project_id)
                } else {
                    slot.phase = Phase::Empty;
                    slot.rebuild.consecutive_failures = 0;
                    slot.rebuild.last_failure = None;
                    self.start_session(&mut slot, state, demand, &config)
                }
            }
            Phase::Empty => self.start_session(&mut slot, state, demand, &config),
            Phase::Preparing => match slot.session.as_mut() {
                Some(session) if session.key != demand.key => {
                    #[cfg(feature = "nir1-graph-eval")]
                    crate::nir1_graph_eval::note_busy_cause("preparing-other-key");
                    self.unserved(GraphUnavailable::Busy, &demand.key.project_id)
                }
                Some(session) => {
                    session.last_demand = demand.now;
                    self.unserved(GraphUnavailable::Warming, &demand.key.project_id)
                }
                None => self.unserved(GraphUnavailable::Warming, &demand.key.project_id),
            },
            Phase::Ready => {
                self.serve_ready(&mut slot, demand, &config)
            }
            Phase::InUse | Phase::Retiring => {
                if let Some(session) = slot.session.as_mut() {
                    if session.key == demand.key {
                        session.last_demand = demand.now;
                    }
                }
                #[cfg(feature = "nir1-graph-eval")]
                crate::nir1_graph_eval::note_busy_cause(if matches!(phase, Phase::InUse) { "in-use" } else { "retiring" });
                self.unserved(GraphUnavailable::Busy, &demand.key.project_id)
            }
        };
        drop(slot);
        (result, finished)
    }

    fn start_session(
        self: &Arc<Self>,
        slot: &mut SlotState,
        state: &Arc<AppState>,
        demand: Demand,
        config: &GraphOwnerConfig,
    ) -> GraphBegin {
        let failures = slot.rebuild.consecutive_failures;
        if failures > 0 {
            if let Some(failed_at) = slot.rebuild.last_failure_at {
                if demand.now < failed_at + failure_backoff(config, failures) {
                    let reason = slot
                        .rebuild
                        .last_failure
                        .unwrap_or(GraphUnavailable::WorkerUnavailable);
                    return self.count_unavailable(reason);
                }
            }
        }
        let thread_id = self.next_thread_id.fetch_add(1, Ordering::SeqCst);
        let (commands, receiver) = mpsc::sync_channel(COMMAND_CAPACITY);
        let context = SessionContext {
            shared: Arc::clone(self),
            state: Arc::downgrade(state),
            factory: demand.factory,
            receiver,
            thread_id,
            key: demand.key.clone(),
            epoch: demand.epoch,
        };
        let spawned = thread::Builder::new()
            .name(OWNER_THREAD_NAME.into())
            .spawn(move || session_main(context));
        match spawned {
            Ok(join) => {
                let warming = self.unserved(GraphUnavailable::Warming, &demand.key.project_id);
                slot.phase = Phase::Preparing;
                slot.session = Some(Session {
                    thread_id,
                    key: demand.key,
                    epoch: demand.epoch,
                    last_demand: demand.now,
                    commands,
                    join: Some(join),
                    pending_rekey: None,
                });
                warming
            }
            Err(_) => {
                slot.rebuild.consecutive_failures = failures.saturating_add(1);
                slot.rebuild.last_failure_at = Some(demand.now);
                slot.rebuild.last_failure = Some(GraphUnavailable::WorkerUnavailable);
                self.count_unavailable(GraphUnavailable::WorkerUnavailable)
            }
        }
    }

    fn serve_ready(
        self: &Arc<Self>,
        slot: &mut SlotState,
        demand: Demand,
        config: &GraphOwnerConfig,
    ) -> GraphBegin {
        let Some(session) = slot.session.as_mut() else {
            return self.count_unavailable(GraphUnavailable::Invalidated);
        };
        if session.key == demand.key {
            if session.epoch != demand.epoch
                || self.edge_epoch.load(Ordering::SeqCst) != session.epoch
            {
                // An edge already happened; the owner retires before any query.
                #[cfg(feature = "nir1-graph-eval")]
                crate::nir1_graph_eval::note_busy_cause("edge-before-query");
                return self.unserved(GraphUnavailable::Busy, &demand.key.project_id);
            }
            session.last_demand = demand.now;
            let cache_key = demand.cache_key;
            let ticket = TicketShared::new(Arc::clone(self), cache_key, demand.epoch);
            let request = demand.request;
            match session.commands.try_send(Command::Query {
                request,
                ticket: Arc::clone(&ticket),
            }) {
                Ok(()) => {
                    slot.phase = Phase::InUse;
                    GraphBegin::Pending(GraphTicket {
                        shared: ticket,
                        finished: false,
                    })
                }
                Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                    #[cfg(feature = "nir1-graph-eval")]
                    crate::nir1_graph_eval::note_busy_cause("command-queue");
                    self.unserved(GraphUnavailable::Busy, &demand.key.project_id)
                }
            }
        } else {
            #[cfg(feature = "nir1-graph-eval")]
            crate::nir1_graph_eval::note_busy_cause("other-key");
            let busy = self.unserved(GraphUnavailable::Busy, &demand.key.project_id);
            if demand.now.saturating_duration_since(session.last_demand)
                >= config.rebuild_min_interval
            {
                session.pending_rekey = Some(PendingRekey {
                    key: demand.key,
                    demand_at: demand.now,
                });
                let _ = session.commands.try_send(Command::Retire);
                slot.phase = Phase::Retiring;
            }
            busy
        }
    }
}

fn take_finished(exited: &mut Vec<JoinHandle<()>>) -> Vec<JoinHandle<()>> {
    let (finished, running): (Vec<_>, Vec<_>) =
        std::mem::take(exited).into_iter().partition(JoinHandle::is_finished);
    *exited = running;
    finished
}

struct SessionContext {
    shared: Arc<Shared>,
    state: Weak<AppState>,
    factory: Arc<dyn GraphWorkerFactory>,
    receiver: Receiver<Command>,
    thread_id: u64,
    key: GraphKey,
    epoch: u64,
}

/// Owns everything the owner thread holds. Its Drop is the single exit path:
/// it settles an in-flight ticket, retires the worker, and updates the slot
/// only if this thread's session is still the slot's session.
struct SessionGuard {
    shared: Arc<Shared>,
    thread_id: u64,
    binding: LiveBinding,
    worker: Option<Box<dyn GraphWorker>>,
    in_flight: Option<Arc<TicketShared>>,
    exit: Option<Phase>,
    quarantined: bool,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(ticket) = self.in_flight.take() {
            ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Failed));
        }
        if let Some(worker) = self.worker.take() {
            if worker.quarantined() {
                self.quarantined = true;
            }
            if worker.retire() == CQueryRetirement::Quarantined {
                self.quarantined = true;
            }
        }
        let mut slot = lock(&self.shared.slot);
        if slot
            .session
            .as_ref()
            .is_some_and(|session| session.thread_id == self.thread_id)
        {
            if let Some(mut session) = slot.session.take() {
                if let Some(join) = session.join.take() {
                    slot.exited.push(join);
                }
            }
        }
        if self.quarantined {
            // slot -> cache is an allowed lock order. The flag and the clear are one
            // step, so a store that raced the quarantine cannot survive it.
            {
                let mut cache = lock(&self.shared.cache);
                self.shared.quarantined.store(true, Ordering::SeqCst);
                *cache = None;
            }
            slot.phase = Phase::Quarantined {
                binding: self.binding.clone(),
            };
            drop(slot);
            bump(&self.shared.diagnostics.quarantines);
        } else if self.shared.closed.load(Ordering::SeqCst) {
            slot.phase = Phase::Closed;
        } else {
            slot.phase = self.exit.take().unwrap_or(Phase::Empty);
        }
    }
}

fn session_main(context: SessionContext) {
    let shared = Arc::clone(&context.shared);
    {
        let mut guard = SessionGuard {
            shared: Arc::clone(&shared),
            thread_id: context.thread_id,
            binding: context.key.binding.clone(),
            worker: None,
            in_flight: None,
            exit: None,
            quarantined: false,
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| run_session(&mut guard, &context)));
        if outcome.is_err() {
            bump(&shared.diagnostics.panics);
        }
    }
    // The guard has published the session's end (the slot phase), so a D-final
    // waiter that wakes now reads the final state.
    shared.signal_ready();
    // The guard has removed this session from the slot and dropped its sender,
    // so nothing can be queued behind this drain.
    settle_queued(&context.receiver);
}

/// A Query queued for a session that ended before serving it settles as
/// invalidated, so no ticket waits on a thread that has gone.
fn settle_queued(receiver: &Receiver<Command>) {
    while let Ok(command) = receiver.try_recv() {
        if let Command::Query { ticket, .. } = command {
            ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Invalidated));
        }
    }
}

enum Next {
    /// Rebuild with the same (or rekeyed) demand, after the rate window.
    Rebuild,
    Exit,
}

fn run_session(guard: &mut SessionGuard, context: &SessionContext) {
    let mut key = context.key.clone();
    let mut epoch = context.epoch;
    loop {
        // A quarantined worker is never followed by another prepare on this thread.
        if guard.quarantined {
            return;
        }
        match build_and_serve(guard, context, &mut key, &mut epoch) {
            Next::Rebuild => continue,
            Next::Exit => return,
        }
    }
}

fn build_and_serve(
    guard: &mut SessionGuard,
    context: &SessionContext,
    key: &mut GraphKey,
    epoch: &mut u64,
) -> Next {
    let shared = Arc::clone(&context.shared);
    if !wait_rebuild_window(context, *epoch) {
        return Next::Exit;
    }
    let Some((snapshot, core, stamp)) = admit(context, key, *epoch) else {
        return Next::Exit;
    };
    guard.worker = Some(context.factory.create(GraphWorkerStart {
        snapshot,
        binding: key.binding.clone(),
        core,
    }));
    let prepare_started = Instant::now();
    bump(&shared.diagnostics.prepares_started);
    {
        let mut slot = lock(&shared.slot);
        slot.rebuild.last_prepare_started = Some(prepare_started);
    }
    let prepared = guard
        .worker
        .as_mut()
        .map(|worker| worker.prepare(&key.project_id));
    match prepared {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            let failure = classify_c_query_failure(&error);
            let (reason, effect) = prepare_failure(failure);
            retire_current(guard);
            if effect == PrepareFailureEffect::Quarantine {
                guard.quarantined = true;
            }
            if effect == PrepareFailureEffect::DoNotCount {
                guard.exit = Some(Phase::Empty);
                return Next::Exit;
            }
            bump(&shared.diagnostics.prepare_failures);
            if effect == PrepareFailureEffect::Count {
                let config = shared.config();
                let mut slot = lock(&shared.slot);
                slot.rebuild.consecutive_failures =
                    slot.rebuild.consecutive_failures.saturating_add(1);
                slot.rebuild.last_failure_at = Some(Instant::now());
                slot.rebuild.last_failure = Some(reason);
                let failures = slot.rebuild.consecutive_failures;
                drop(slot);
                guard.exit = Some(if failures >= config.failures_before_suspend {
                    Phase::Suspended {
                        ready_generation: shared.ready_generation.load(Ordering::SeqCst),
                        reason,
                    }
                } else {
                    Phase::Empty
                });
            }
            return Next::Exit;
        }
        None => return Next::Exit,
    }
    // READY: the worker is prepared on this thread and not yet queried.
    if shared.edge_epoch.load(Ordering::SeqCst) != *epoch || shared.closed.load(Ordering::SeqCst) {
        retire_current(guard);
        return Next::Exit;
    }
    {
        let mut slot = lock(&shared.slot);
        slot.phase = Phase::Ready;
        slot.rebuild.consecutive_failures = 0;
        slot.rebuild.last_failure = None;
    }
    bump(&shared.diagnostics.prepares_ready);
    shared.signal_ready();
    if shared.take_unserved(&key.project_id) {
        shared.notify_ready(&key.project_id);
    }
    serve_until_retired(guard, context, key, epoch, stamp)
}

fn retire_current(guard: &mut SessionGuard) {
    if let Some(worker) = guard.worker.take() {
        if worker.quarantined() {
            guard.quarantined = true;
        }
        if worker.retire() == CQueryRetirement::Quarantined {
            guard.quarantined = true;
        }
    }
}

/// Waits out the minimum rebuild interval and failure backoff, serving only
/// edge and retire commands meanwhile. Returns false when the thread must exit.
fn wait_rebuild_window(context: &SessionContext, epoch: u64) -> bool {
    let shared = Arc::clone(&context.shared);
    lock(&shared.slot).phase = Phase::Preparing;
    loop {
        let config = shared.config();
        let not_before = {
            let slot = lock(&shared.slot);
            rebuild_not_before(&config, &slot.rebuild)
        };
        let now = Instant::now();
        let Some(not_before) = not_before else {
            return !edge_or_closed(&shared, epoch);
        };
        if now >= not_before {
            return !edge_or_closed(&shared, epoch);
        }
        match context.receiver.recv_timeout(not_before - now) {
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => return false,
            Ok(Command::Wake) => {
                if edge_or_closed(&shared, epoch) {
                    bump(&shared.diagnostics.retired_edge);
                    return false;
                }
            }
            // No rekey is pending while preparing, so a Retire here is stale.
            Ok(Command::Retire) => {}
            Ok(Command::Query { ticket, .. }) => {
                #[cfg(feature = "nir1-graph-eval")]
                ticket.eval_notes.busy("rebuild-window");
                ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Busy));
            }
        }
    }
}

fn edge_or_closed(shared: &Shared, epoch: u64) -> bool {
    shared.edge_epoch.load(Ordering::SeqCst) != epoch || shared.closed.load(Ordering::SeqCst)
}

/// Retire then take the pending rekey, if any. Returns true when the session
/// continues with the new key (phase Preparing), false when it must exit.
fn rekey(shared: &Shared, guard: &mut SessionGuard, key: &mut GraphKey, epoch: &mut u64) -> bool {
    retire_current(guard);
    if guard.quarantined {
        return false;
    }
    let mut slot = lock(&shared.slot);
    let next = slot
        .session
        .as_mut()
        .and_then(|session| session.pending_rekey.take());
    match next {
        Some(pending) => {
            let next = pending.key;
            if let Some(session) = slot.session.as_mut() {
                session.key = next.clone();
                session.epoch = shared.edge_epoch.load(Ordering::SeqCst);
                session.last_demand = pending.demand_at;
            }
            slot.phase = Phase::Preparing;
            guard.binding = next.binding.clone();
            *key = next;
            *epoch = shared.edge_epoch.load(Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Checks the admission conditions and takes the S0 freshness stamp. The
/// workspace pin is kept only for prepare; the Native lock is never held here.
fn admit(
    context: &SessionContext,
    key: &GraphKey,
    epoch: u64,
) -> Option<(ActiveWorkspaceSnapshot, WorkspaceLifecycleCore, Option<CQueryFreshnessStamp>)> {
    let shared = &context.shared;
    if edge_or_closed(shared, epoch) {
        return None;
    }
    let state = context.state.upgrade()?;
    let status = state.profile_egress.status();
    if !(status.restricted && status.in_flight_stopped) {
        return None;
    }
    let snapshot = active_workspace_snapshot(&state.ws).ok()?;
    let current = ready_binding(&state)?;
    if current != key.binding
        || snapshot.db().identity() != key.binding.authority_instance
        || snapshot.path().to_string_lossy().as_ref() != key.binding.locator.as_ref()
    {
        return None;
    }
    let stamp = try_read_c_query_freshness_stamp(snapshot.db().db());
    if stamp.is_none() {
        bump(&shared.diagnostics.stamp0_missing);
    }
    let core = state.ws.lifecycle_core();
    drop(state);
    if edge_or_closed(shared, epoch) {
        return None;
    }
    Some((snapshot, core, stamp))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ServeNext {
    Ready,
    Rebuild,
    Exit,
}

/// Serves demand while READY. The worker is queried at most once; after the
/// query (or a stale verdict) it is retired and the session rebuilds.
fn serve_until_retired(
    guard: &mut SessionGuard,
    context: &SessionContext,
    key: &mut GraphKey,
    epoch: &mut u64,
    stamp0: Option<CQueryFreshnessStamp>,
) -> Next {
    let shared = Arc::clone(&context.shared);
    loop {
        let config = shared.config();
        let idle_remaining = {
            let mut slot = lock(&shared.slot);
            let remaining = slot.session.as_ref().map_or(Duration::ZERO, |session| {
                idle_deadline(&config, session.last_demand)
                    .saturating_duration_since(Instant::now())
            });
            if remaining.is_zero() {
                let rekey_asked = matches!(slot.phase, Phase::Retiring);
                if rekey_asked || matches!(slot.phase, Phase::Ready) {
                    // Decided under the slot lock. Once Retiring, begin sends this
                    // session no Query, so none can wait behind the retirement.
                    slot.phase = Phase::Retiring;
                    drop(slot);
                    if !rekey_asked {
                        bump(&shared.diagnostics.retired_idle);
                    }
                    return retire_then_rekey_or_exit(guard, &shared, key, epoch);
                }
            }
            remaining
        };
        match context.receiver.recv_timeout(idle_remaining) {
            Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => {
                retire_current(guard);
                return Next::Exit;
            }
            Ok(Command::Wake) => {
                if edge_or_closed(&shared, *epoch) {
                    bump(&shared.diagnostics.retired_edge);
                    begin_retiring(&shared);
                    retire_current(guard);
                    return Next::Exit;
                }
            }
            Ok(Command::Retire) => {
                if rekey_pending(&shared) {
                    return retire_then_rekey_or_exit(guard, &shared, key, epoch);
                }
            }
            Ok(Command::Query { request, ticket }) => {
                match serve_query(guard, context, *epoch, stamp0.as_ref(), request, ticket) {
                    ServeNext::Ready => {}
                    ServeNext::Rebuild => return Next::Rebuild,
                    ServeNext::Exit => return Next::Exit,
                }
            }
        }
    }
}

/// Edge and shutdown retirement: a Ready session stops taking Queries first.
fn begin_retiring(shared: &Shared) {
    let mut slot = lock(&shared.slot);
    if matches!(slot.phase, Phase::Ready) {
        slot.phase = Phase::Retiring;
    }
}

/// A Retire command means something only while a rekey is pending for it.
/// Without one, the demand it announced was already served, so it is stale.
fn rekey_pending(shared: &Shared) -> bool {
    lock(&shared.slot)
        .session
        .as_ref()
        .is_some_and(|session| session.pending_rekey.is_some())
}

fn retire_then_rekey_or_exit(
    guard: &mut SessionGuard,
    shared: &Shared,
    key: &mut GraphKey,
    epoch: &mut u64,
) -> Next {
    if rekey(shared, guard, key, epoch) {
        Next::Rebuild
    } else {
        retire_current(guard);
        Next::Exit
    }
}

fn serve_query(
    guard: &mut SessionGuard,
    context: &SessionContext,
    epoch: u64,
    stamp0: Option<&CQueryFreshnessStamp>,
    request: Nir1GraphRequest,
    ticket: Arc<TicketShared>,
) -> ServeNext {
    let shared = &context.shared;
    guard.in_flight = Some(Arc::clone(&ticket));
    if edge_or_closed(shared, epoch) {
        ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Invalidated));
        guard.in_flight = None;
        retire_current(guard);
        return ServeNext::Exit;
    }
    if ticket.cancel.load(Ordering::SeqCst) {
        ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled));
        guard.in_flight = None;
        return_to_ready(shared);
        return ServeNext::Ready;
    }
    #[cfg(feature = "nir1-graph-eval")]
    let eval_stamp_attempted_at = Instant::now();
    let stamp1 = read_stamp_for_query(context, &guard.binding);
    #[cfg(feature = "nir1-graph-eval")]
    ticket.eval_notes.stamp(eval_stamp_attempted_at, stamp0, stamp1.as_ref());
    match (stamp0, stamp1.as_ref()) {
        (Some(before), Some(after)) if before != after => {
            bump(&shared.diagnostics.stamp_stale);
            ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Stale));
            guard.in_flight = None;
            retire_current(guard);
            if guard.quarantined {
                return ServeNext::Exit;
            }
            return ServeNext::Rebuild;
        }
        (Some(_), Some(_)) => bump(&shared.diagnostics.stamp_fresh),
        _ => bump(&shared.diagnostics.stamp_unavailable),
    }
    if ticket.cancel.load(Ordering::SeqCst) {
        ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled));
        guard.in_flight = None;
        return_to_ready(shared);
        return ServeNext::Ready;
    }
    let Some(worker) = guard.worker.as_mut() else {
        ticket.deliver(GraphTicketOutcome::Unavailable(GraphUnavailable::Failed));
        guard.in_flight = None;
        return ServeNext::Exit;
    };
    let result = worker.query(&request, &ticket.cancel);
    let worker = guard.worker.take();
    let quarantined = worker.as_ref().is_some_and(|worker| worker.quarantined());
    let retirement = worker.map(|worker| worker.retire());
    let retirement_quarantined = retirement == Some(CQueryRetirement::Quarantined);
    let outcome = match result {
        Ok(projection) => {
            if edge_or_closed(shared, epoch) {
                GraphTicketOutcome::Unavailable(GraphUnavailable::Invalidated)
            } else if ticket.cancel.load(Ordering::SeqCst) {
                GraphTicketOutcome::Unavailable(GraphUnavailable::Cancelled)
            } else {
                if projection.graph.scene_total > MAX_GRAPH_SCENES {
                    bump(&shared.diagnostics.scene_total_over_cap);
                }
                let query_scene = request.query_scene_id.as_str();
                if projection
                    .graph
                    .scenes
                    .iter()
                    .any(|scene| scene.scene_id == query_scene)
                {
                    bump(&shared.diagnostics.query_scene_associated);
                }
                GraphTicketOutcome::Available(Arc::new(projection))
            }
        }
        Err(error) => {
            let failure = classify_c_query_failure(&error);
            #[cfg(feature = "nir1-graph-eval")]
            if matches!(failure, CQueryFailure::CapacityBusy) {
                ticket.eval_notes.busy("worker-capacity");
            }
            if matches!(
                failure,
                CQueryFailure::Unavailable(UnavailableReason::RegistrationDrift)
            ) {
                bump(&shared.diagnostics.drift_at_query);
            }
            GraphTicketOutcome::Unavailable(query_failure(failure))
        }
    };
    ticket.deliver(outcome);
    guard.in_flight = None;
    if quarantined || retirement_quarantined {
        guard.quarantined = true;
        return ServeNext::Exit;
    }
    if edge_or_closed(shared, epoch) {
        return ServeNext::Exit;
    }
    ServeNext::Rebuild
}

fn return_to_ready(shared: &Shared) {
    lock(&shared.slot).phase = Phase::Ready;
}

fn read_stamp_for_query(context: &SessionContext, binding: &LiveBinding) -> Option<CQueryFreshnessStamp> {
    let state = context.state.upgrade()?;
    let db = active_database(&state.ws).ok()?;
    if db.identity() != binding.authority_instance {
        return None;
    }
    try_read_c_query_freshness_stamp(db.db())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PrepareFailureEffect {
    Count,
    DoNotCount,
    Quarantine,
}

fn prepare_failure(failure: CQueryFailure) -> (GraphUnavailable, PrepareFailureEffect) {
    match failure {
        CQueryFailure::Unavailable(_)
        | CQueryFailure::Deadline
        | CQueryFailure::Cancelled
        | CQueryFailure::WorkerStartup
        | CQueryFailure::Other => (GraphUnavailable::WorkerUnavailable, PrepareFailureEffect::Count),
        CQueryFailure::BindingLost => (GraphUnavailable::Invalidated, PrepareFailureEffect::DoNotCount),
        CQueryFailure::CapacityBusy => (GraphUnavailable::Busy, PrepareFailureEffect::DoNotCount),
        CQueryFailure::CleanupUnproved => (
            GraphUnavailable::RestartRequired,
            PrepareFailureEffect::Quarantine,
        ),
        CQueryFailure::StartupRegistrationRefused => (
            GraphUnavailable::RegistrationUnavailable,
            PrepareFailureEffect::Count,
        ),
    }
}

fn query_failure(failure: CQueryFailure) -> GraphUnavailable {
    match failure {
        CQueryFailure::Unavailable(reason) => GraphUnavailable::from_category(reason.category()),
        CQueryFailure::Deadline => GraphUnavailable::Timeout,
        CQueryFailure::Cancelled => GraphUnavailable::Cancelled,
        CQueryFailure::BindingLost => GraphUnavailable::Invalidated,
        CQueryFailure::CapacityBusy => GraphUnavailable::Busy,
        CQueryFailure::CleanupUnproved => GraphUnavailable::RestartRequired,
        CQueryFailure::StartupRegistrationRefused
        | CQueryFailure::WorkerStartup
        | CQueryFailure::Other => GraphUnavailable::Failed,
    }
}

/// Core's snapshot when it is Ready; any other state has no Graph binding.
fn ready_binding(state: &AppState) -> Option<LiveBinding> {
    let snapshot = state.ws.lifecycle_core().snapshot().ok()?;
    match snapshot.state {
        LifecycleState::Ready(binding) => Some(binding),
        _ => None,
    }
}

/// Pure: the minimum-interval and failure-backoff deadline for the next prepare.
pub(crate) fn rebuild_not_before(
    config: &GraphOwnerConfig,
    ledger: &RebuildLedger,
) -> Option<Instant> {
    let mut not_before = ledger
        .last_prepare_started
        .map(|started| started + config.rebuild_min_interval);
    if ledger.consecutive_failures > 0 {
        if let Some(failed_at) = ledger.last_failure_at {
            let backoff_until = failed_at + failure_backoff(config, ledger.consecutive_failures);
            not_before = Some(match not_before {
                Some(existing) => existing.max(backoff_until),
                None => backoff_until,
            });
        }
    }
    not_before
}

/// Pure: 0 for no failures, otherwise initial × 2^(n−1) capped at the maximum.
pub(crate) fn failure_backoff(config: &GraphOwnerConfig, consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        return Duration::ZERO;
    }
    let mut delay = config.failure_backoff_initial;
    for _ in 1..consecutive_failures.min(65) {
        if delay >= config.failure_backoff_max {
            break;
        }
        match delay.checked_mul(2) {
            Some(doubled) => delay = doubled,
            None => return config.failure_backoff_max,
        }
    }
    delay.min(config.failure_backoff_max)
}

/// Pure: the idle deadline, measured from the last demand.
pub(crate) fn idle_deadline(config: &GraphOwnerConfig, last_demand: Instant) -> Instant {
    last_demand + config.idle_retire_after
}

/// Pure: a cache entry is usable only for the same key and edge epoch, and
/// strictly before its TTL (exactly at the TTL it is not).
fn cache_entry_usable(
    entry: &CacheEntry,
    key: &CacheKey,
    edge_epoch: u64,
    now: Instant,
    ttl: Duration,
) -> bool {
    entry.key == *key && entry.edge_epoch == edge_epoch && now < entry.stored_at + ttl
}

/// Pure: a quarantined binding conflicts with a target by locator, workspace
/// identity, or the same main database file identity.
pub(crate) fn quarantine_conflicts(
    quarantined: &LiveBinding,
    locator: &str,
    workspace_id: Option<&str>,
    identity: Option<&str>,
) -> bool {
    quarantined.locator.as_ref() == locator
        || workspace_id.is_some_and(|id| quarantined.workspace_id.as_ref() == id)
        || identity.is_some_and(|id| quarantined.matches_main_database_file_identity(id))
}

