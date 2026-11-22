//! One call, from the blocking task's first line to the answer, and the order
//! in which the task releases what it holds.
//!
//! The steps that touch the database or the model are behind [`Backend`], so
//! the order of the steps, the deadline, the ledger and the tail are tested
//! without a model and without a published Chronicle index (the shared crate's
//! `ChatIrQuery` and `PendingTerminalAudit` cannot be made without one).

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};

use super::basis::Basis;
use super::item::{items_wire, IrItem};
use super::ledger::Ledger;
use super::permit::Permit;
use super::request::Request;
use super::status::ChatIrStatus;
use super::tail::{run_tail, TailFlush, TailTiming};
use super::ChatIrConfig;

/// What the third read (T3) yields besides the items, from the same snapshot
/// (S1-A2).
#[derive(Clone, Debug, Default)]
pub(crate) struct Selection {
    pub(crate) items: Vec<IrItem>,
    /// revision ID -> the Chronicle event its payload names, only for the
    /// revisions of `items` and only while that event exists (A1).
    pub(crate) event_ids: BTreeMap<String, String>,
    /// The candidates of the request that the IR admission rule excludes for
    /// this query (A2), in the request's order. A subset of the request's
    /// candidates.
    pub(crate) excluded: Vec<String>,
}

/// The answer. `items` and `event_ids` are empty unless the status is
/// `available`; `excluded` is read only when the status is a success.
#[derive(Debug)]
pub(crate) struct ChatIrResult {
    pub(crate) status: ChatIrStatus,
    pub(crate) items: Vec<IrItem>,
    pub(crate) event_ids: BTreeMap<String, String>,
    pub(crate) excluded: Vec<String>,
}

impl ChatIrResult {
    pub(crate) fn status_only(status: ChatIrStatus) -> Self {
        Self {
            status,
            items: Vec::new(),
            event_ids: BTreeMap::new(),
            excluded: Vec::new(),
        }
    }

    /// `success` is true only for `available` and `none-above-threshold`, so an
    /// IR that could not be answered is never read as "no relevant scene".
    ///
    /// `excludedEventIds` is an array only on a success and `null` otherwise
    /// ("not judged"): a failure never reads as "nothing was excluded"
    /// (DR-CHATIR-S1-43). Whatever `excluded` holds on a failure is dropped
    /// here, so the rule is in one place.
    pub(crate) fn to_wire(&self) -> Value {
        let excluded = if self.status.is_success() {
            json!(self.excluded)
        } else {
            Value::Null
        };
        let event_ids = json!(self.event_ids);
        json!({
            "status": self.status.as_str(),
            "success": self.status.is_success(),
            "items": items_wire(&self.items),
            "eventIds": event_ids,
            "excludedEventIds": excluded,
        })
    }
}

/// What the first read yields: what the call derives from the project's
/// language and the first snapshot of the index.
pub(crate) struct FirstRead<S> {
    pub(crate) basis: Basis,
    pub(crate) snapshot: S,
}

pub(crate) enum Prepared<Q, P> {
    Query(Q),
    Unavailable {
        status: ChatIrStatus,
        pending: Option<P>,
    },
}

pub(crate) trait Backend {
    type Snapshot;
    type Batch;
    type Query;
    type Pending: TailFlush;

    /// T1: before anything is embedded. The project's language, the current
    /// Scene, the status of the index. Waits at most `probe` for the connection
    /// and never takes an admission or an embedder (so a busy connection ends
    /// the call before anything is held).
    fn first_read(
        &self,
        request: &Request,
        deadline: Instant,
        probe: std::time::Duration,
    ) -> Result<FirstRead<Self::Snapshot>, ChatIrStatus>;

    /// Embed the query. Called outside every read transaction: the audit
    /// appends inside it need the connection a transaction would hold.
    fn prepare(
        &self,
        request: &Request,
        basis: &Basis,
        deadline: Instant,
    ) -> Result<Prepared<Self::Query, Self::Pending>, ChatIrStatus>;

    /// T2: qualify the admitted documents of the first snapshot. Derives the
    /// language again and refuses when it is not `first.language`.
    fn qualify(
        &self,
        request: &Request,
        first: &Basis,
        snapshot: &Self::Snapshot,
        deadline: Instant,
    ) -> Result<Self::Batch, ChatIrStatus>;

    fn score(
        &self,
        query: &Self::Query,
        basis: &Basis,
        batch: &Self::Batch,
        deadline: Instant,
    ) -> Result<Vec<f32>, ChatIrStatus>;

    /// T3: select, project and validate. Derives the language, the floor and
    /// the cap again and refuses when the language is not `first.language`.
    /// The event IDs of the items and the excluded candidates are read in the
    /// same transaction, before the validation, so they share the snapshot.
    #[allow(clippy::too_many_arguments)]
    fn select(
        &self,
        request: &Request,
        first: &Basis,
        query: &Self::Query,
        batch: &Self::Batch,
        scores: Vec<f32>,
        deadline: Instant,
    ) -> Result<Selection, ChatIrStatus>;

    /// The participant's stop request (a transition or a shutdown). An error
    /// reading it counts as a request.
    fn stop_requested(&self) -> bool;

    /// The identity of the workspace database the call runs on.
    fn db_identity(&self) -> u64;
}

struct Ended<P> {
    status: ChatIrStatus,
    pending: Option<P>,
}

impl<P> From<ChatIrStatus> for Ended<P> {
    fn from(status: ChatIrStatus) -> Self {
        Self {
            status,
            pending: None,
        }
    }
}

/// The steps of one call. `Err` carries the closed status and the terminal
/// records that must still be written (only `prepare` can produce them).
pub(crate) fn run_call<B: Backend>(
    backend: &B,
    config: &ChatIrConfig,
    ledger: &Mutex<Ledger>,
    request: &Request,
    accepted_at: Instant,
) -> (ChatIrResult, Option<B::Pending>) {
    match run_steps(backend, config, ledger, request, accepted_at) {
        Ok(result) => (result, None),
        Err(ended) => (ChatIrResult::status_only(ended.status), ended.pending),
    }
}

fn run_steps<B: Backend>(
    backend: &B,
    config: &ChatIrConfig,
    ledger: &Mutex<Ledger>,
    request: &Request,
    accepted_at: Instant,
) -> Result<ChatIrResult, Ended<B::Pending>> {
    let deadline = accepted_at + config.deadline;
    // The wait for the blocking pool is part of the deadline.
    if Instant::now() >= deadline {
        return Err(ChatIrStatus::Timeout.into());
    }
    let first = backend.first_read(request, deadline, config.connection_probe)?;
    let query = match backend.prepare(request, &first.basis, deadline)? {
        Prepared::Query(query) => query,
        Prepared::Unavailable { status, pending } => return Err(Ended { status, pending }),
    };
    let batch = backend.qualify(request, &first.basis, &first.snapshot, deadline)?;
    let scores = backend.score(&query, &first.basis, &batch, deadline)?;
    let Selection {
        items,
        event_ids,
        excluded,
    } = backend.select(request, &first.basis, &query, &batch, scores, deadline)?;
    // An answer after the deadline is not returned, and nothing is issued.
    if Instant::now() >= deadline {
        return Err(ChatIrStatus::Timeout.into());
    }
    if items.is_empty() {
        // A success that carries the exclusions: the year table needs them
        // even when no IR item came back.
        return Ok(ChatIrResult {
            excluded,
            ..ChatIrResult::status_only(ChatIrStatus::NoneAboveThreshold)
        });
    }
    ledger
        .lock()
        .map_err(|_| ChatIrStatus::Internal)?
        .issue(backend.db_identity(), &items)
        .map_err(|_| ChatIrStatus::LedgerFull)?;
    Ok(ChatIrResult {
        status: ChatIrStatus::Available,
        items,
        event_ids,
        excluded,
    })
}

/// The blocking task. It answers first, then writes the pending terminal
/// records (the tail), then releases in the order pending, backend (the pinned
/// request, then the participant), permit. The order is not a guarantee (the
/// workspace's sole-owner wait polls for 10 s); what must hold is that nothing
/// outlives the task and that the tail after a stop request is short.
pub(crate) fn execute<B: Backend>(
    backend: B,
    permit: Permit,
    config: ChatIrConfig,
    ledger: &Mutex<Ledger>,
    request: Request,
    accepted_at: Instant,
    answer: tokio::sync::oneshot::Sender<ChatIrResult>,
) {
    let (result, pending) = run_call(&backend, &config, ledger, &request, accepted_at);
    // The answer does not wait for the tail. A dropped receiver (the caller is
    // gone) changes nothing here.
    let _ = answer.send(result);
    if let Some(mut pending) = pending {
        let timing = TailTiming {
            budget: config.tail_budget,
            slice: config.tail_slice,
            close_flush: config.close_flush,
        };
        let end = run_tail(&mut pending, &timing, || backend.stop_requested());
        tracing::debug!(?end, "chat IR terminal audit tail ended");
        drop(pending);
    }
    drop(request);
    drop(backend);
    drop(permit);
}
