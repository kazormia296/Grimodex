//! CP-3a S2a: the Graph half of a Related Scenes operation.
//!
//! `begin` hands one query to the Graph product owner (wait 0, no database
//! read, no join) and the operation keeps the resulting ticket in a slot.
//! `related_scenes_graph_continue` is the only way to wait for it, and it also
//! carries the renderer's settle declaration (D5), so no second command exists.
//!
//! * The slot lives and dies with the operation lease (D1): invalidation,
//!   release, owner release, transition and expiry all cancel the ticket, and
//!   dropping the operation drops the ticket, which counts as cancelled.
//! * A ticket reaches `Unused` (and so the owner's next-query cache and the
//!   `graph-ready` notice) only through the renderer's explicit `unused`
//!   declaration. A plain release cancels: Main releases the operation of a
//!   `related_scenes_begin` result it refused to publish through the same
//!   command, and such a result must not be cached (P3).
//! * One operation, one await, one verification. A second `graph_continue`
//!   always answers `cancelled`; nothing but identifiers is kept, never a
//!   response, an excerpt or a body (P2-1, Mandatory defense 5).
//! * The await is bounded by `GRAPH_AWAIT_LIMIT` (D7), which covers only the
//!   wait for the ticket and the IR response, never a verification (P1-1).
//! * CQ-DEFER (D′): `begin` hands the query over as a *held* one
//!   (`begin_deferred`), and releases it only once its own audit commits are
//!   over (`DeferredRelease`); a worker prepared or queried before them would
//!   drift. The Graph therefore always arrives after Raw-ready (graph-late).
//!
//! The response assembly (path additions, the Graph-only row, click-time
//! requalification) is `graph_response.rs`; this module stops at "the Graph is
//! here and the operation is still current", and returns what that module made
//! once the gate, the lease and the declaration have been looked at again.
use super::graph_response::{self, ClickEntry};
use super::*;
use crate::nir1_graph_product::{
    GraphBegin, GraphQuery, GraphTicket, GraphTicketOutcome, GraphTicketUse, GraphTicketWaiter,
    GraphUnavailable,
};
use grimodex_db::narrative_extraction::nir1_graph::worker_projection::Nir1GraphProjection;
use std::sync::Condvar;

/// D7: the most a `graph_continue` waits for the ticket and the IR response.
/// A query normally resolves in about the worker's 100 ms; the cap only keeps a
/// `spawn_blocking` thread from being held. It is not a verification budget and
/// is not applied once both are in hand.
pub(super) const GRAPH_AWAIT_LIMIT: Duration = Duration::from_secs(2);
const GRAPH_WAIT_STEP: Duration = Duration::from_millis(25);
const REQUEST_ID_UTF16_MAX: usize = 200;

#[derive(Default)]
pub(super) struct GraphState {
    inner: Mutex<GraphInner>,
}

struct GraphInner {
    slot: GraphSlot,
    /// The Scene IDs of the dense hits `begin` returned. Raw R is a selection
    /// out of them, so a claimed R outside this set is refused (P1-2).
    dense_scene_ids: Option<HashSet<String>>,
    /// Set by the first await; the operation verifies at most once.
    claimed: bool,
    /// The owner's lifecycle edge epoch when the query was handed over.
    edge_epoch: u64,
    /// The Graph-only row the one response of this operation showed, by its
    /// opaque handle: the binding and the path's identifiers and tokens a click
    /// is compared with. At most one; it lives and dies with the lease. Never a
    /// response, an excerpt, a body or path text (DR-CP3A-25).
    click: Option<(String, ClickEntry)>,
}

impl Default for GraphInner {
    fn default() -> Self {
        Self {
            slot: GraphSlot::NotStarted(GraphUnavailable::NotRequested),
            dense_scene_ids: None,
            claimed: false,
            edge_epoch: 0,
            click: None,
        }
    }
}

enum GraphSlot {
    /// No query is running (no seed, the gate is closed, the owner refused).
    NotStarted(GraphUnavailable),
    /// The owner accepted the query; the ticket settles exactly once.
    Pending(GraphTicket),
    /// The owner's single-entry cache hit. It is not authority; the await
    /// carries it into the same verification as a fresh result.
    Cached(Arc<Nir1GraphProjection>),
    /// The renderer's declaration, or a cancellation. The ticket is finished
    /// (with the first declaration; later ones are ignored).
    Settled,
}

/// What the first await leaves behind to wait on.
pub(super) struct AwaitPlan {
    source: AwaitSource,
    edge_epoch: u64,
}

enum AwaitSource {
    Ticket(GraphTicketWaiter),
    Cached(Arc<Nir1GraphProjection>),
}

pub(super) enum Claim {
    /// Answer with this reason now: nothing to wait for, nothing to read.
    Reply(GraphUnavailable),
    /// The claimed R is not a selection out of the dense hits.
    Violation,
    Await(AwaitPlan),
}

pub(super) enum GraphAwait {
    Unavailable(GraphUnavailable),
    Ready(Arc<Nir1GraphProjection>),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum IrState {
    Pending,
    Available,
    Unavailable,
}

/// RS-JOIN (DR-RSJ-3, DR-RSJ-4): what the Graph await of one operation waits
/// on besides its ticket. The scoring thread advances the generation once the
/// IR response is in the slot; an IR continue of the same operation is counted
/// while it delivers that response (its Chronicle recheck included), and
/// advances the generation when it leaves.
#[derive(Default)]
pub(super) struct IrJoin {
    state: Mutex<IrJoinState>,
    changed: Condvar,
}

#[derive(Default)]
struct IrJoinState {
    generation: u64,
    continues: usize,
}

/// An IR continue of the operation in flight (DR-RSJ-4). Dropped on every
/// exit of `continue_query`, an unwind included.
pub(super) struct IrContinueInFlight<'a>(&'a IrJoin);

impl Drop for IrContinueInFlight<'_> {
    fn drop(&mut self) {
        let mut state = lock_inner(&self.0.state);
        state.continues = state.continues.saturating_sub(1);
        state.generation = state.generation.wrapping_add(1);
        drop(state);
        self.0.changed.notify_all();
    }
}

impl IrJoin {
    /// The IR response is in the slot (or the operation's IR has failed).
    pub(super) fn notify(&self) {
        let mut state = lock_inner(&self.state);
        state.generation = state.generation.wrapping_add(1);
        drop(state);
        self.changed.notify_all();
    }

    pub(super) fn enter(&self) -> IrContinueInFlight<'_> {
        lock_inner(&self.state).continues += 1;
        IrContinueInFlight(self)
    }

    pub(super) fn in_flight(&self) -> bool {
        lock_inner(&self.state).continues > 0
    }

    fn generation(&self) -> u64 {
        lock_inner(&self.state).generation
    }

    /// Waits at most `step`, and not at all once something changed since
    /// `seen`. A missed wake costs at most `step`, as the sleep it replaces.
    fn wait_since(&self, seen: u64, step: Duration) {
        let state = lock_inner(&self.state);
        let _ = self
            .changed
            .wait_timeout_while(state, step, |state| state.generation == seen)
            .unwrap_or_else(std::sync::PoisonError::into_inner);
    }
}

/// DR-RSJ-4: an IR that an IR continue of this operation is still delivering
/// is not the Graph's yet; that continue's recheck goes first. A stopped IR is
/// never hidden.
pub(super) fn ir_for_graph(ir: IrState, continue_in_flight: bool) -> IrState {
    if ir == IrState::Available && continue_in_flight {
        IrState::Pending
    } else {
        ir
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct LeaseProbe {
    pub(super) live: bool,
    pub(super) ir: IrState,
}

impl GraphState {
    /// Hands the query to the owner, held until `release_after_own_commits`,
    /// and keeps the answer. Never waits and reads no database. Returns the
    /// `graph` field of the `begin` response.
    pub(super) fn start(&self, state: &Arc<AppState>, query: GraphQuery) -> Value {
        let edge_epoch = state.nir1_graph.edge_epoch();
        let begin = state.nir1_graph.begin_deferred(state, query);
        let (slot, wire) = match begin {
            GraphBegin::Pending(ticket) => (GraphSlot::Pending(ticket), graph_pending()),
            // A cache hit also answers `pending`: it is re-verified in the
            // await like any result, and `begin` has no Raw selection yet (D2).
            GraphBegin::Cached(projection) => (GraphSlot::Cached(projection), graph_pending()),
            GraphBegin::Unavailable(reason) => {
                (GraphSlot::NotStarted(reason), graph_unavailable(reason))
            }
        };
        let mut inner = lock_inner(&self.inner);
        inner.edge_epoch = edge_epoch;
        inner.slot = slot;
        wire
    }

    /// The lifecycle epoch of the owner when the query was handed over.
    pub(super) fn edge_epoch(&self) -> u64 {
        lock_inner(&self.inner).edge_epoch
    }

    /// Keeps the Graph-only row of the response that is leaving, replacing any
    /// earlier one (an operation is verified once, so there is none).
    pub(super) fn keep_click(&self, identity: String, entry: ClickEntry) {
        lock_inner(&self.inner).click = Some((identity, entry));
    }

    /// The Graph-only row behind `identity`, if this operation showed it.
    pub(super) fn click_entry(&self, identity: &str) -> Option<ClickEntry> {
        lock_inner(&self.inner)
            .click
            .as_ref()
            .filter(|(kept, _)| kept == identity)
            .map(|(_, entry)| entry.clone())
    }

    pub(super) fn set_dense_scene_ids(&self, ids: HashSet<String>) {
        lock_inner(&self.inner).dense_scene_ids = Some(ids);
    }

    /// CQ-DEFER: the begin's own commits are over; the owner may prepare for
    /// the held query now. Like `declare`, the owner is called outside the
    /// lock. Wait-free; does nothing unless a query is held for this slot.
    pub(super) fn release_after_own_commits(&self) {
        let release = match &lock_inner(&self.inner).slot {
            GraphSlot::Pending(ticket) => Some(ticket.release_handle()),
            _ => None,
        };
        if let Some(release) = release {
            release.release_after_own_commits();
        }
    }

    /// Cancels a running query. The ticket is finished outside the lock: its
    /// settlement may reach the owner's notifier.
    pub(super) fn cancel(&self) {
        self.declare(GraphTicketUse::Cancelled);
    }

    /// The renderer's declaration. The first one wins; later ones do nothing.
    pub(super) fn declare(&self, use_: GraphTicketUse) {
        let ticket = {
            let mut inner = lock_inner(&self.inner);
            let running = matches!(inner.slot, GraphSlot::Pending(_) | GraphSlot::Cached(_));
            if running {
                match std::mem::replace(&mut inner.slot, GraphSlot::Settled) {
                    GraphSlot::Pending(ticket) => Some(ticket),
                    _ => None,
                }
            } else {
                None
            }
        };
        if let Some(ticket) = ticket {
            ticket.finish(use_);
        }
    }

    pub(super) fn is_settled(&self) -> bool {
        matches!(lock_inner(&self.inner).slot, GraphSlot::Settled)
    }

    /// Starts the one await of this operation. `raw_scene_ids` was shape
    /// checked; it must also be a selection out of the dense hits. Nothing is
    /// read here and nothing is waited for.
    pub(super) fn claim(&self, raw_scene_ids: &[String]) -> Claim {
        let mut inner = lock_inner(&self.inner);
        match &inner.slot {
            GraphSlot::NotStarted(reason) => return Claim::Reply(*reason),
            GraphSlot::Settled => return Claim::Reply(GraphUnavailable::Cancelled),
            GraphSlot::Pending(_) | GraphSlot::Cached(_) => {}
        }
        if inner.claimed {
            return Claim::Reply(GraphUnavailable::Cancelled);
        }
        let selection_of_dense_hits = inner
            .dense_scene_ids
            .as_ref()
            .is_some_and(|dense| raw_scene_ids.iter().all(|id| dense.contains(id)));
        if !selection_of_dense_hits {
            return Claim::Violation;
        }
        inner.claimed = true;
        let edge_epoch = inner.edge_epoch;
        let source = match &inner.slot {
            GraphSlot::Pending(ticket) => AwaitSource::Ticket(ticket.waiter()),
            GraphSlot::Cached(projection) => AwaitSource::Cached(Arc::clone(projection)),
            GraphSlot::NotStarted(_) | GraphSlot::Settled => {
                return Claim::Reply(GraphUnavailable::Cancelled)
            }
        };
        Claim::Await(AwaitPlan { source, edge_epoch })
    }
}

fn lock_inner<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

pub(super) fn graph_pending() -> Value {
    json!({"status": "pending"})
}

pub(super) fn graph_unavailable(reason: GraphUnavailable) -> Value {
    json!({"status": "unavailable", "reason": reason.as_str()})
}

/// Waits (on a thread that owns no async runtime) for the ticket and the IR
/// response, at most `limit`. Every step looks at the declaration, the lease,
/// the owner and the lifecycle epoch, so a cancellation, a Chronicle stop or a
/// shutdown ends the wait within one step. No verification happens here.
#[cfg(test)]
pub(super) fn await_graph(
    state: &AppState,
    graph: &GraphState,
    plan: &AwaitPlan,
    limit: Duration,
    probe: impl Fn() -> LeaseProbe,
) -> GraphAwait {
    await_graph_joined(state, graph, plan, limit, GRAPH_WAIT_STEP, None, probe)
}

/// `await_graph` that wakes on `join` (DR-RSJ-3) while only the IR is missing,
/// instead of sleeping the whole step. Every check of the loop is unchanged.
pub(super) fn await_graph_joined(
    state: &AppState,
    graph: &GraphState,
    plan: &AwaitPlan,
    limit: Duration,
    step_limit: Duration,
    join: Option<&IrJoin>,
    probe: impl Fn() -> LeaseProbe,
) -> GraphAwait {
    let deadline = Instant::now() + limit;
    loop {
        // Read before the probe: a change after it ends the wait at once.
        let seen = join.map(IrJoin::generation);
        if graph.is_settled() {
            return GraphAwait::Unavailable(GraphUnavailable::Cancelled);
        }
        let lease = probe();
        if !lease.live {
            return GraphAwait::Unavailable(GraphUnavailable::Invalidated);
        }
        if state.nir1_graph.is_closed() || state.nir1_graph.edge_epoch() != plan.edge_epoch {
            return GraphAwait::Unavailable(GraphUnavailable::Invalidated);
        }
        // A Chronicle that stopped stops the Graph too: exact R (DSN §3.1).
        if lease.ir == IrState::Unavailable {
            return GraphAwait::Unavailable(GraphUnavailable::Cancelled);
        }
        let outcome = match &plan.source {
            AwaitSource::Cached(projection) => {
                Some(GraphTicketOutcome::Available(Arc::clone(projection)))
            }
            AwaitSource::Ticket(waiter) => waiter.wait_timeout(Duration::ZERO),
        };
        match &outcome {
            Some(GraphTicketOutcome::Unavailable(reason)) => {
                return GraphAwait::Unavailable(*reason)
            }
            Some(GraphTicketOutcome::Available(projection)) if lease.ir == IrState::Available => {
                return GraphAwait::Ready(Arc::clone(projection))
            }
            _ => {}
        }
        let now = Instant::now();
        if now >= deadline {
            return GraphAwait::Unavailable(GraphUnavailable::Timeout);
        }
        let step = step_limit.min(deadline - now);
        match (&plan.source, &outcome, join.zip(seen)) {
            // The ticket is still running: sleep on it, not on a timer.
            (AwaitSource::Ticket(waiter), None, _) => {
                let _ = waiter.wait_timeout(step);
            }
            // Only the IR response is missing: wake when it arrives.
            (_, _, Some((join, seen))) => join.wait_since(seen, step),
            (_, _, None) => std::thread::sleep(step),
        }
    }
}

// ---- the wire -------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawContinueRequest {
    operation_ticket: String,
    raw_scene_ids: Option<Vec<String>>,
    settle: Option<SettleWire>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) enum SettleWire {
    Used,
    Unused,
    Cancelled,
}

impl SettleWire {
    fn ticket_use(self) -> GraphTicketUse {
        match self {
            Self::Used => GraphTicketUse::Used,
            Self::Unused => GraphTicketUse::Unused,
            Self::Cancelled => GraphTicketUse::Cancelled,
        }
    }
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum GraphContinueRequest {
    /// `{ operationTicket, rawSceneIds }`: wait for the Graph.
    Await {
        operation_ticket: String,
        raw_scene_ids: Vec<String>,
    },
    /// `{ operationTicket, settle }`: declare what the renderer did with it.
    Settle {
        operation_ticket: String,
        settle: SettleWire,
    },
}

impl GraphContinueRequest {
    /// Exactly one of the two shapes. Shape errors are request errors, not
    /// Graph states; they change nothing.
    pub(super) fn parse(value: Value) -> Result<Self> {
        let invalid = || anyhow!("RELATED_SCENES_INVALID_REQUEST");
        // `null` is not absence: serde would read it as `None` and let
        // `{rawSceneIds, settle: null}` pass as an await. Main refuses it too
        // (DR-CP3A-33); Native does not rely on that (DR-CP3A-47).
        ensure!(
            value
                .as_object()
                .is_some_and(|fields| !fields.values().any(Value::is_null)),
            "RELATED_SCENES_INVALID_REQUEST"
        );
        let raw: RawContinueRequest = serde_json::from_value(value).map_err(|_| invalid())?;
        ensure!(
            !raw.operation_ticket.trim().is_empty()
                && raw.operation_ticket.encode_utf16().count() <= REQUEST_ID_UTF16_MAX,
            "RELATED_SCENES_INVALID_REQUEST"
        );
        match (raw.raw_scene_ids, raw.settle) {
            (Some(raw_scene_ids), None) => {
                let (max_raw, _) = ranking_policy::fusion_limits()?;
                ensure!(
                    raw_scene_ids.len() <= max_raw,
                    "RELATED_SCENES_INVALID_REQUEST"
                );
                let mut seen = HashSet::new();
                for id in &raw_scene_ids {
                    ensure!(
                        !id.trim().is_empty()
                            && id.encode_utf16().count() <= REQUEST_ID_UTF16_MAX
                            && seen.insert(id.as_str()),
                        "RELATED_SCENES_INVALID_REQUEST"
                    );
                }
                Ok(Self::Await {
                    operation_ticket: raw.operation_ticket,
                    raw_scene_ids,
                })
            }
            (None, Some(settle)) => Ok(Self::Settle {
                operation_ticket: raw.operation_ticket,
                settle,
            }),
            _ => Err(invalid()),
        }
    }
}

// ---- the entry ------------------------------------------------------------

/// The operation's `graph` field for a `begin` that carried a seed (D1, D6).
/// Starts a query only when an IR operation exists: the merge helper never
/// uses a Graph without it, and a query started for nothing costs the single
/// worker slot. Without a lease the answer is `not-requested`, and the owner is
/// not touched.
pub(super) fn begin_graph<T: LeaseEnd>(
    state: &Arc<AppState>,
    lease: Option<&LeaseOf<T>>,
    project_id: &str,
    query_scene_id: &str,
    seed_entity_id: &str,
) -> Value {
    let Some(lease) = lease else {
        return graph_unavailable(GraphUnavailable::NotRequested);
    };
    let wire = lease.data.graph().start(
        state,
        GraphQuery {
            project_id: project_id.to_owned(),
            query_scene_id: query_scene_id.to_owned(),
            seed_entity_id: seed_entity_id.to_owned(),
        },
    );
    // The operation may have been invalidated while the query was handed over.
    if !lease.is_live(Instant::now()) {
        lease.data.graph().cancel();
    }
    wire
}

/// CQ-DEFER: the begin's hold on its Graph query (DR-CQD-6). Made right after
/// `begin_graph`; `release` once the begin's outcome is `Ok` (every commit of
/// the begin is over and no participant read is open). Every other exit (an
/// `Err`, an early return, an unwind) drops it, which cancels the held query,
/// so a begin never leaves a hold behind.
pub(super) struct DeferredRelease<T: LeaseEnd> {
    lease: Option<LeaseOf<T>>,
}

impl<T: LeaseEnd> DeferredRelease<T> {
    pub(super) fn new(lease: Option<LeaseOf<T>>) -> Self {
        Self { lease }
    }

    pub(super) fn release(mut self) {
        if let Some(lease) = self.lease.take() {
            lease.data.graph().release_after_own_commits();
        }
    }
}

impl<T: LeaseEnd> Drop for DeferredRelease<T> {
    fn drop(&mut self) {
        if let Some(lease) = self.lease.take() {
            lease.data.graph().cancel();
        }
    }
}

fn lease_probe<T: LeaseEnd>(lease: &LeaseOf<T>) -> LeaseProbe {
    LeaseProbe {
        live: lease.is_live(Instant::now()),
        ir: ir_for_graph(lease.data.ir_state(), lease.data.ir_join().in_flight()),
    }
}

/// The reason the Graph may not be handed out now, if any. The owner already
/// checked these at `begin`; they are checked again where the result leaves.
pub(super) fn gate_reason(state: &AppState) -> Option<GraphUnavailable> {
    if state.nir1_graph.is_closed() {
        return Some(GraphUnavailable::Invalidated);
    }
    if !state.nir1_graph.publication_is_open() {
        return Some(GraphUnavailable::NotActivated);
    }
    let status = state.profile_egress.status();
    if !(status.restricted && status.in_flight_stopped) {
        return Some(GraphUnavailable::ProfileNotRestricted);
    }
    None
}

/// `related_scenes_graph_continue`. The caller (the N-API entry) has admitted
/// the call and runs the return-time recheck on the result.
pub(crate) async fn graph_continue(
    state: Arc<AppState>,
    owner: String,
    request: Value,
) -> Result<Value> {
    match GraphContinueRequest::parse(request)? {
        GraphContinueRequest::Settle {
            operation_ticket,
            settle,
        } => match settle_in(
            &state.related_scenes.registry,
            &owner,
            &operation_ticket,
            settle.ticket_use(),
            Instant::now(),
        )? {
            Settled::Declared => Ok(json!({"status": "settled"})),
            Settled::Unknown => Ok(unavailable("cancelled")),
            Settled::Expired(lease) => {
                announce_invalidated(&state, &lease);
                Ok(unavailable("cancelled"))
            }
        },
        GraphContinueRequest::Await {
            operation_ticket,
            raw_scene_ids,
        } => await_request(state, owner, operation_ticket, raw_scene_ids).await,
    }
}

pub(super) enum Settled<T> {
    /// The declaration reached the live operation's ticket.
    Declared,
    /// No such operation for this owner: nothing changed.
    Unknown,
    /// The operation is no longer live. It took no declaration: its ticket is
    /// cancelled with it, so its late result reaches neither the cache nor
    /// `graph-ready`. The caller delivers the withdrawal signal.
    Expired(LeaseOf<T>),
}

/// The settle form (D5). Only a live operation takes a declaration; an
/// expired one is invalidated instead, like every other call that finds it.
pub(super) fn settle_in<T: LeaseEnd>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    owner: &str,
    ticket: &str,
    use_: GraphTicketUse,
    now: Instant,
) -> Result<Settled<T>> {
    let Some(lease) = owned_in(registry, owner, ticket)? else {
        return Ok(Settled::Unknown);
    };
    if !lease.is_live(now) {
        // The invalidation cancels the ticket; a caller that won the race to
        // invalidate it first has cancelled it already.
        return Ok(if invalidate_from_registry(registry, ticket, &lease)? {
            Settled::Expired(lease)
        } else {
            Settled::Unknown
        });
    }
    lease.data.graph().declare(use_);
    Ok(Settled::Declared)
}

async fn await_request(
    state: Arc<AppState>,
    owner: String,
    ticket: String,
    raw_scene_ids: Vec<String>,
) -> Result<Value> {
    let reply = |reason: GraphUnavailable| -> Result<Value> { Ok(unavailable(reason.as_str())) };
    let Some(lease) = state.related_scenes.owned(&owner, &ticket)? else {
        return reply(GraphUnavailable::Cancelled);
    };
    if !lease.is_live(Instant::now()) {
        invalidate(&state, &ticket, &lease)?;
        return reply(GraphUnavailable::Invalidated);
    }
    let plan = match lease.data.graph.claim(&raw_scene_ids) {
        Claim::Reply(reason) => return reply(reason),
        Claim::Violation => {
            // A renderer that names an R it was never given loses the Graph.
            lease.data.graph.cancel();
            return reply(GraphUnavailable::Cancelled);
        }
        Claim::Await(plan) => plan,
    };
    let waiting = {
        let state = Arc::clone(&state);
        let lease = lease.clone();
        tokio::task::spawn_blocking(move || {
            await_graph_joined(
                &state,
                &lease.data.graph,
                &plan,
                GRAPH_AWAIT_LIMIT,
                GRAPH_WAIT_STEP,
                Some(&lease.data.join),
                || lease_probe(&lease),
            )
        })
        .await
    };
    let projection = match waiting {
        Ok(GraphAwait::Ready(projection)) => projection,
        Ok(GraphAwait::Unavailable(reason)) => return reply(reason),
        Err(_) => return reply(GraphUnavailable::Failed),
    };
    // The same Chronicle recheck a plain `continue` makes before it returns.
    let current = {
        let state = Arc::clone(&state);
        let lease = lease.clone();
        tokio::task::spawn_blocking(move || current_operation(&state, &lease)).await
    };
    match current {
        Ok(Ok(true)) => {}
        Ok(Ok(false)) => {
            invalidate(&state, &ticket, &lease)?;
            return reply(GraphUnavailable::Invalidated);
        }
        Ok(Err(error)) => return Err(error),
        Err(_) => return reply(GraphUnavailable::Failed),
    }
    if let Some(reason) = gate_reason(&state) {
        return reply(reason);
    }
    // The requalification reads the database: on a blocking thread, with the
    // operation's own checkpoint. An `Err` of any kind is a failure of the
    // whole Graph and says nothing about a Graph-only candidate.
    let assembled = {
        let state = Arc::clone(&state);
        let lease = lease.clone();
        let raw_scene_ids = raw_scene_ids.clone();
        tokio::task::spawn_blocking(move || {
            graph_response::assemble(&state, &lease, &projection, &raw_scene_ids)
        })
        .await
    };
    let assembled = match assembled {
        Ok(Ok(assembled)) => assembled,
        Ok(Err(error)) => {
            return stopped(&state, &ticket, &lease, graph_response::classify(&error))
        }
        Err(_) => return reply(GraphUnavailable::Failed),
    };
    let graph_response::Assembled::Available { wire, click } = assembled else {
        let graph_response::Assembled::Unavailable(reason) = assembled else {
            unreachable!("an assembly is available or unavailable")
        };
        return stopped(&state, &ticket, &lease, reason);
    };
    // The payload leaves only if everything still holds where it leaves: the
    // renderer has not settled, the lease is live, the gate is open and the
    // workspace is the one the operation was made for. The handle of the
    // Graph-only row is kept last, so a discarded payload leaves none.
    if lease.data.graph.is_settled() {
        return reply(GraphUnavailable::Cancelled);
    }
    if !lease.is_live(Instant::now()) {
        return stopped(&state, &ticket, &lease, GraphUnavailable::Invalidated);
    }
    if let Some(reason) = gate_reason(&state) {
        return reply(reason);
    }
    if !current_request(&state, &lease.data.request)? {
        return stopped(&state, &ticket, &lease, GraphUnavailable::Invalidated);
    }
    graph_response::keep_click(&lease.data.graph, click);
    Ok(wire)
}

/// The unavailable answer of an await that ended in `reason`; an operation
/// whose lease has ended is invalidated, as every other path does.
fn stopped(
    state: &AppState,
    ticket: &str,
    lease: &Lease,
    reason: GraphUnavailable,
) -> Result<Value> {
    if !lease.is_live(Instant::now()) {
        invalidate(state, ticket, lease)?;
    }
    Ok(unavailable(reason.as_str()))
}

#[cfg(test)]
#[path = "graph_tests.rs"]
mod tests;
