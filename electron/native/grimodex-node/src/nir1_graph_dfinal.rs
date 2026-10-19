//! DI-1a S3: D-final's request for the Graph, its bounded wait and the kind of
//! result it keeps (K6/2 `nir1-final-request-packing-eval`, DSN §5.1 and §1.3
//! E7).
//!
//! D-final asks the product owner (CP-2a) for the Graph of the query Scene's
//! seed **before** it opens the participant read, holding no database mutex,
//! SQLite transaction, profile or lifecycle lock. The freshness stamp of the
//! owner is a wait-0 read of the parent's main connection; a request made
//! from inside a participant read would always find it held.
//!
//! The wait is rule (i) of K6/2: a `warming` or `stale` answer waits for a
//! READY up to the budget W and asks once more per READY signal; everything
//! else (busy, limit, timeout, an unavailable worker, a closed product) is
//! not waited for. Whatever happens, the request continues, with the Graph or
//! without it. The wait runs on the thread that runs D-final and ends on a
//! stop, a shutdown, a lifecycle edge or a revoked route.
//!
//! The owner's answer reaches D-final as a [`Nir1GraphCandidates`]: IDs and
//! tokens only. The participant read of D-final requalifies it (S1).
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::Result;
use grimodex_db::{
    narrative_extraction::{
        is_validation_terminated, read_nir1_graph_seed, NativeNir1GraphOutcome,
        Nir1GraphCandidates, Nir1GraphDropReason, Nir1GraphExclusionReason, Nir1GraphSeedRead,
    },
    state::ActiveWorkspaceSnapshot,
    ParticipantSqlOperationBudget,
};

use crate::{
    nir1_graph_product::{
        GraphBegin, GraphQuery, GraphTicket, GraphTicketOutcome, GraphTicketUse, GraphUnavailable,
    },
    state::AppState,
};

#[cfg(test)]
#[path = "nir1_graph_dfinal_tests.rs"]
pub(crate) mod tests;

/// W: the whole budget of the Graph step (the wait for a READY and the wait
/// for the query's ticket together). It is inside the 20 s SQL deadline that
/// D-final starts with; DR-DI1A-5b records the measurement that chose it. A
/// send waits at most this long for the Graph, then goes without it.
pub(crate) const GRAPH_WAIT_BUDGET: Duration = Duration::from_secs(4);
/// How often a wait looks at the stop, shutdown, lifecycle and route flags.
pub(crate) const GRAPH_WAIT_STEP: Duration = Duration::from_millis(25);
/// What the rest of D-final (the participant read, the rendering and the
/// re-validation) keeps of the 20 s SQL deadline after the Graph step.
const GRAPH_STEP_RESERVE: Duration = Duration::from_secs(10);
const _: () = assert!(
    GRAPH_WAIT_BUDGET.as_millis() + GRAPH_STEP_RESERVE.as_millis()
        <= crate::nir1_prepared_request::PREPARATION_SQL_TIMEOUT.as_millis()
);
const _: () = assert!(GRAPH_WAIT_STEP.as_millis() > 0);
const _: () = assert!(GRAPH_WAIT_STEP.as_millis() <= GRAPH_WAIT_BUDGET.as_millis());

/// The wait budget and step of one request. Production uses the constants;
/// a test installs shorter values on the owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct GraphWaitPlan {
    pub(crate) budget: Duration,
    pub(crate) step: Duration,
}

impl Default for GraphWaitPlan {
    fn default() -> Self {
        Self {
            budget: GRAPH_WAIT_BUDGET,
            step: GRAPH_WAIT_STEP,
        }
    }
}

/// Why a `busy` answer was given (DR-DI1A-8). The owner never turns an
/// unreadable freshness stamp into `busy` by itself; this is the diagnostic
/// correlation the reach investigation reads.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphBusyCause {
    /// The slot was in use, retiring or preparing for another key.
    SlotInUse,
    /// The owner's freshness-stamp counters moved during this request: a stamp
    /// could not be read.
    StampUnreadable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphWaitKind {
    Warming,
    Stale,
    /// A query was running (a pending ticket) and had not settled when the
    /// wait budget ran out. Not the owner's own `Timeout` (the worker's lease
    /// ran out), which the owner returns as `Unavailable(Timeout)`.
    Query,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphInvalidation {
    /// The seed rule, read again in the snapshot, named another Entity.
    Seed,
    /// A binding token (or the candidate's project or Scene) differs.
    Binding,
    /// B's seal differs or is absent.
    Seal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum GraphNotUsed {
    /// The shared input envelope could not hold any Graph group.
    Limit,
    /// The Graph groups would have left no accepted IR; the IR groups stay.
    RequiredContext,
}

/// The kind of result D-final's Graph step ended with. A closed set, counts
/// and closed reasons only: no identifier and no text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DFinalGraphOutcome {
    /// There was nothing to ask: the Scene has no pinned Entity, or the entry
    /// does not request a Graph (the caller's Revision list).
    NotRequested,
    Unavailable {
        reason: GraphUnavailable,
        busy_cause: Option<GraphBusyCause>,
    },
    /// The wait budget ran out while the owner was still warming or stale.
    WaitExpired(GraphWaitKind),
    /// A Graph arrived and D-final's snapshot refused all of it.
    Invalidated(GraphInvalidation),
    NotUsed(GraphNotUsed),
    /// A Graph arrived, and each of its Revisions was left out.
    Excluded {
        revisions: usize,
    },
    /// A Graph arrived and passed the snapshot, but no Graph group was adopted
    /// into the request: the Graph had no relation to offer, or every group
    /// was left out later (DR-DI1A-8).
    Empty,
    /// Graph groups were adopted into the request: `groups` is the number of
    /// Graph inputs the request carries.
    Used {
        groups: usize,
        excluded_revisions: usize,
        limited: usize,
    },
}

impl DFinalGraphOutcome {
    fn unavailable(reason: GraphUnavailable) -> Self {
        Self::Unavailable {
            reason,
            busy_cause: None,
        }
    }

    /// The kind D-final ends with once the snapshot has spoken (or not, for a
    /// Graph that never reached it). `adopted_inputs` is the number of Graph
    /// inputs the request carries after packing (`graph_binding().inputs()`),
    /// not the number of groups the pool once held.
    pub(crate) fn finalize(
        requested: GraphRequest,
        snapshot: Option<&NativeNir1GraphOutcome>,
        adopted_inputs: usize,
    ) -> Self {
        if let GraphRequest::Skipped(outcome) = requested {
            return outcome;
        }
        let Some(snapshot) = snapshot else {
            return Self::unavailable(GraphUnavailable::Failed);
        };
        if let Some(reason) = snapshot.dropped_reason() {
            return match reason {
                Nir1GraphDropReason::NotNativeSelection => Self::NotRequested,
                Nir1GraphDropReason::ProjectOrSceneMismatch => {
                    Self::Invalidated(GraphInvalidation::Binding)
                }
                Nir1GraphDropReason::SeedChanged => Self::Invalidated(GraphInvalidation::Seed),
                Nir1GraphDropReason::SealUnavailable | Nir1GraphDropReason::SealMismatch => {
                    Self::Invalidated(GraphInvalidation::Seal)
                }
                Nir1GraphDropReason::WouldRemoveRequiredAcceptedIr => {
                    Self::NotUsed(GraphNotUsed::RequiredContext)
                }
            };
        }
        let excluded = snapshot.excluded();
        let limited = snapshot.limited_count();
        if adopted_inputs > 0 {
            return Self::Used {
                groups: adopted_inputs,
                excluded_revisions: excluded.len(),
                limited,
            };
        }
        if !snapshot.groups().is_empty() {
            // Groups reached the pool and none survived packing.
            return Self::Empty;
        }
        if !excluded.is_empty() {
            if excluded
                .iter()
                .all(|exclusion| exclusion.reason() == Nir1GraphExclusionReason::BindingMismatch)
            {
                return Self::Invalidated(GraphInvalidation::Binding);
            }
            return Self::Excluded {
                revisions: excluded.len(),
            };
        }
        if limited > 0 {
            return Self::NotUsed(GraphNotUsed::Limit);
        }
        Self::Empty
    }
}

/// What the request step produced for D-final's snapshot.
pub(crate) enum GraphRequest {
    /// No Graph reaches the snapshot; the outcome is already known.
    Skipped(DFinalGraphOutcome),
    /// A Graph (as text-free candidates) reaches the snapshot, which decides.
    Reached,
}

/// Everything the request step needs of the D-final that calls it.
pub(crate) struct GraphRequestContext<'a> {
    pub(crate) state: &'a Arc<AppState>,
    pub(crate) workspace: &'a ActiveWorkspaceSnapshot,
    pub(crate) project_id: &'a str,
    pub(crate) query_scene_id: &'a str,
    /// The submission's stop flag (the same one the SQL budget watches).
    pub(crate) stop: &'a AtomicBool,
    /// The route revocation generation D-final read when it resolved the route.
    pub(crate) route_revocation_generation: u64,
    pub(crate) sql_budget: ParticipantSqlOperationBudget,
}

/// Ask for the Graph of the query Scene's seed, waiting as rule (i) says.
///
/// Returns the text-free candidates for the snapshot, or the reason there are
/// none. An `Err` is the request's own end (a cancellation, a shutdown, a
/// lifecycle transition or the SQL deadline), which ends D-final as it would at
/// its own read. A transient database failure of the short seed read is not:
/// the Graph is optional, so it becomes `Unavailable(Failed)` and D-final goes
/// on without it (DR-DI1A-24).
pub(crate) fn request_graph(
    context: &GraphRequestContext<'_>,
) -> Result<(GraphRequest, Option<Nir1GraphCandidates>)> {
    let skipped = |outcome| Ok((GraphRequest::Skipped(outcome), None));
    let owner = &context.state.nir1_graph;
    // A closed product reads nothing (A-17): not even the seed.
    if !owner.publication_is_open() {
        return skipped(DFinalGraphOutcome::unavailable(
            GraphUnavailable::NotActivated,
        ));
    }
    let seed = match read_nir1_graph_seed(
        context.workspace,
        context.project_id,
        context.query_scene_id,
        context.sql_budget.clone(),
    ) {
        Ok(seed) => seed,
        // The Graph is optional material: a transient database failure of this
        // short read must not refuse a send the body's own read could serve
        // (DR-DI1A-24). A cancellation, a shutdown, a transition or the end of
        // the SQL deadline is the request's own end and stays an `Err`.
        Err(error) if !seed_read_ends_the_request(&error, context) => {
            return skipped(DFinalGraphOutcome::unavailable(GraphUnavailable::Failed));
        }
        Err(error) => return Err(error),
    };
    let seed_entity_id = match seed {
        Nir1GraphSeedRead::NoPin => return skipped(DFinalGraphOutcome::NotRequested),
        Nir1GraphSeedRead::TooLarge => {
            return skipped(DFinalGraphOutcome::unavailable(GraphUnavailable::Limit));
        }
        Nir1GraphSeedRead::Pinned(entity_id) => entity_id,
    };
    let query = GraphQuery {
        project_id: context.project_id.to_owned(),
        query_scene_id: context.query_scene_id.to_owned(),
        seed_entity_id,
    };
    let plan = owner.dfinal_wait_plan();
    let started = Instant::now();
    let deadline = started + plan.budget;
    let edge_epoch = owner.edge_epoch();
    let stamp_misses_before = stamp_misses(owner.diagnostics());
    let cancelled = || {
        context.stop.load(Ordering::SeqCst)
            || context
                .state
                .workspace_shutdown_requested
                .load(Ordering::Acquire)
            || owner.is_closed()
            || owner.edge_epoch() != edge_epoch
            || context.state.profile_egress.revocation_generation()
                != context.route_revocation_generation
    };
    let unavailable = |reason: GraphUnavailable| {
        let busy_cause = (reason == GraphUnavailable::Busy)
            .then(|| busy_cause_of(stamp_misses_before, stamp_misses(owner.diagnostics())));
        Ok((
            GraphRequest::Skipped(DFinalGraphOutcome::Unavailable { reason, busy_cause }),
            None,
        ))
    };

    loop {
        if cancelled() {
            return unavailable(GraphUnavailable::Cancelled);
        }
        // Read before `begin`, so a READY that lands in between is not lost.
        let signal = owner.ready_signal_generation();
        let wait_kind = match owner.begin(context.state, query.clone()) {
            GraphBegin::Cached(projection) => {
                return reached(Nir1GraphCandidates::from_projection(&projection));
            }
            GraphBegin::Pending(ticket) => {
                match wait_for_ticket(ticket, deadline, plan.step, &cancelled) {
                    TicketWait::Settled(GraphTicketOutcome::Available(projection)) => {
                        // The ticket was finished as used by the wait.
                        let candidates = Nir1GraphCandidates::from_projection(&projection);
                        drop(projection);
                        return reached(candidates);
                    }
                    TicketWait::Settled(GraphTicketOutcome::Unavailable(
                        GraphUnavailable::Stale,
                    )) => GraphWaitKind::Stale,
                    TicketWait::Settled(GraphTicketOutcome::Unavailable(reason)) => {
                        return unavailable(reason);
                    }
                    TicketWait::Expired => {
                        return Ok((
                            GraphRequest::Skipped(DFinalGraphOutcome::WaitExpired(
                                GraphWaitKind::Query,
                            )),
                            None,
                        ));
                    }
                    TicketWait::Cancelled => return unavailable(GraphUnavailable::Cancelled),
                }
            }
            GraphBegin::Unavailable(GraphUnavailable::Warming) => GraphWaitKind::Warming,
            GraphBegin::Unavailable(GraphUnavailable::Stale) => GraphWaitKind::Stale,
            // Not a state a READY changes: go on without the Graph.
            GraphBegin::Unavailable(reason) => return unavailable(reason),
        };
        // Warming or stale: wait for the next READY (or the end of the
        // session that was preparing), then ask again.
        match wait_for_signal(owner, signal, deadline, plan.step, &cancelled) {
            SignalWait::Signalled => {}
            SignalWait::Expired => {
                return Ok((
                    GraphRequest::Skipped(DFinalGraphOutcome::WaitExpired(wait_kind)),
                    None,
                ));
            }
            SignalWait::Cancelled => return unavailable(GraphUnavailable::Cancelled),
        }
    }
}

/// Whether a failed seed read is the end of the request itself (cancelled,
/// shut down, a lifecycle transition, the SQL deadline) rather than a
/// transient failure of the optional Graph step.
fn seed_read_ends_the_request(error: &anyhow::Error, context: &GraphRequestContext<'_>) -> bool {
    is_validation_terminated(error)
        || context.stop.load(Ordering::SeqCst)
        || context
            .state
            .workspace_shutdown_requested
            .load(Ordering::Acquire)
        || context
            .sql_budget
            .check_workspace(context.workspace)
            .is_err()
}

fn reached(
    candidates: Result<Nir1GraphCandidates>,
) -> Result<(GraphRequest, Option<Nir1GraphCandidates>)> {
    Ok(match candidates {
        Ok(candidates) => (GraphRequest::Reached, Some(candidates)),
        Err(_) => (
            GraphRequest::Skipped(DFinalGraphOutcome::unavailable(GraphUnavailable::Failed)),
            None,
        ),
    })
}

/// Pure: a `busy` answer while the owner's stamp counters moved is attributed
/// to an unreadable stamp; otherwise to the slot.
///
/// This is an inference from the owner's counters, not a cause the owner
/// reports: a stamp miss of another consumer's query in the same interval is
/// counted too. The reach record (S4, A-8) takes the cause from the owner's
/// diagnostics, and DD-1 does not take this value as evidence of a cause.
fn busy_cause_of(stamp_misses_before: u64, stamp_misses_after: u64) -> GraphBusyCause {
    if stamp_misses_after > stamp_misses_before {
        GraphBusyCause::StampUnreadable
    } else {
        GraphBusyCause::SlotInUse
    }
}

fn stamp_misses(diagnostics: crate::nir1_graph_product::GraphOwnerDiagnostics) -> u64 {
    diagnostics
        .stamp0_missing
        .saturating_add(diagnostics.stamp_unavailable)
}

enum TicketWait {
    Settled(GraphTicketOutcome),
    Expired,
    Cancelled,
}

/// Waits for one ticket in short steps and finishes it: `Used` when it
/// delivered a Graph, `Unused` when it delivered an unavailable answer, and
/// `Cancelled` (by dropping it) when the wait ends first.
fn wait_for_ticket(
    ticket: GraphTicket,
    deadline: Instant,
    step: Duration,
    cancelled: &impl Fn() -> bool,
) -> TicketWait {
    loop {
        if cancelled() {
            return TicketWait::Cancelled;
        }
        let now = Instant::now();
        if now >= deadline {
            return TicketWait::Expired;
        }
        if let Some(outcome) = ticket.wait_timeout(step.min(deadline - now)) {
            let use_ = match outcome {
                GraphTicketOutcome::Available(_) => GraphTicketUse::Used,
                GraphTicketOutcome::Unavailable(_) => GraphTicketUse::Unused,
            };
            ticket.finish(use_);
            return TicketWait::Settled(outcome);
        }
    }
}

enum SignalWait {
    Signalled,
    Expired,
    Cancelled,
}

/// Blocks in short steps until the owner's READY signal moves past `since`.
fn wait_for_signal(
    owner: &crate::nir1_graph_product::Nir1GraphProductOwner,
    since: u64,
    deadline: Instant,
    step: Duration,
    cancelled: &impl Fn() -> bool,
) -> SignalWait {
    loop {
        if cancelled() {
            return SignalWait::Cancelled;
        }
        let now = Instant::now();
        if now >= deadline {
            return SignalWait::Expired;
        }
        if owner.wait_ready_signal(since, step.min(deadline - now)) {
            return SignalWait::Signalled;
        }
    }
}
