//! CP-4 S1a: the evaluation-only Graph arm of the Native (K6/2
//! `graph-eval-procedure`, Mandatory defenses; CP-4 TASK D8, D9, §15.3).
//!
//! This module exists only under the `nir1-graph-eval` cargo feature. The
//! feature is never in `default`, is never enabled by the normal N-API build or
//! release packaging, and its `.node` is written only outside
//! `electron/native/grimodex-node/` and is never distributed.
//! `PRODUCT_GRAPH_PUBLISHED` stays false; nothing here changes a product build.
//!
//! - `register` is called once by `Backend::new` of the evaluation build. It
//!   keeps a `Weak<AppState>` in a process-wide registry, configures the
//!   C-query worker from the fixed name next to the loaded `.node`
//!   (`WORKER_FILE_NAME`; no N-API entry takes a worker path), and opens the
//!   publication gate of that AppState's owner only.
//! - The `nir1GraphEval*` functions are free N-API functions of the addon. The
//!   harness reaches them from Main through Playwright's `app.evaluate`, by
//!   requiring the same `.node` path (Node's module cache returns the module
//!   Main loaded). They are not in the IPC contract, the preload or the
//!   renderer, and they never write.
//! - The per-`begin` records keep no identifier, path, binding or text: the
//!   order, the eval clock, the slot phase, the outcome and the settlement.
//! - The A3 record opens its own read-only connection (grimodex-db
//!   `nir1_graph_eval::read_a3_read_only`) and takes neither the DB mutex nor a
//!   lifecycle participant.
// `register` and the N-API functions are reached from `Backend::new` and Node
// only, so a test build does not call them.
#![cfg_attr(test, allow(dead_code))]

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError, Weak};
use std::time::Instant;

use napi::bindgen_prelude::Error;
use napi_derive::napi;
use serde_json::{json, Value};

use crate::nir1_graph_product::{
    GraphBegin, GraphSlotKind, GraphTicketUse, GraphTicketWaiter, GraphUnavailable,
    Nir1GraphProductOwner,
};
use crate::state::AppState;

#[cfg(test)]
mod tests;

pub(crate) const FEATURE: &str = "nir1-graph-eval";
/// The worker's fixed name next to the loaded `.node` (the same name the
/// product factory requires).
pub(crate) const WORKER_FILE_NAME: &str = if cfg!(windows) {
    "nir1-c-query-worker.exe"
} else {
    "nir1-c-query-worker"
};
/// The most `begin` records kept. Past it the oldest is dropped and counted.
pub(crate) const SAMPLE_CAPACITY: usize = 1024;
const STATUS_SCHEMA: &str = "nir1-graph-eval-status/1";
const DIAGNOSTICS_SCHEMA: &str = "nir1-graph-eval-diagnostics/1";
const SAMPLES_SCHEMA: &str = "nir1-graph-eval-samples/1";
const A3_SCHEMA: &str = "nir1-graph-eval-a3/1";
const NOT_REGISTERED: &str = "NIR1_GRAPH_EVAL_NOT_REGISTERED";

// ---- the eval clock -------------------------------------------------------

static ANCHOR: OnceLock<Instant> = OnceLock::new();

fn anchor() -> Instant {
    *ANCHOR.get_or_init(Instant::now)
}

/// Nanoseconds since the eval clock's anchor (the first registration). Every
/// time of every record is on this clock; `nir1GraphEvalClockNs` lets the
/// harness align it with its own.
pub(crate) fn clock_ns(at: Instant) -> u64 {
    u64::try_from(at.saturating_duration_since(anchor()).as_nanos()).unwrap_or(u64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ---- the registry ---------------------------------------------------------

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum WorkerSetup {
    Configured(PathBuf),
    Refused {
        path: Option<PathBuf>,
        reason: String,
    },
    /// Tests register without resolving a worker.
    #[cfg_attr(not(test), allow(dead_code))]
    NotAttempted,
}

#[derive(Clone)]
struct Registration {
    state: Weak<AppState>,
    registrations: u64,
    registered_at: Instant,
    worker: WorkerSetup,
}

/// A leaf lock: it is never held while another lock is taken.
static REGISTRY: Mutex<Option<Registration>> = Mutex::new(None);

/// `Backend::new` of the evaluation build. The worker is configured before the
/// gate opens, so a `begin` never sees an open gate without its worker.
pub(crate) fn register(state: &Arc<AppState>) {
    let worker = match loaded_library_path() {
        Ok(library) => configure_worker(state, &library),
        Err(error) => WorkerSetup::Refused {
            path: None,
            reason: format!("{error:#}"),
        },
    };
    record_registration(state, worker);
}

pub(crate) fn record_registration(state: &Arc<AppState>, worker: WorkerSetup) {
    let registered_at = Instant::now();
    let _ = anchor();
    state.nir1_graph.open_publication_for_eval();
    let mut registry = lock(&REGISTRY);
    let registrations = registry.as_ref().map_or(0, |r| r.registrations) + 1;
    *registry = Some(Registration {
        state: Arc::downgrade(state),
        registrations,
        registered_at,
        worker,
    });
}

/// `<directory of the loaded library>/nir1-c-query-worker`, validated by the
/// product factory (absolute, a file, the fixed name, an absolute parent).
pub(crate) fn configure_worker(state: &AppState, library: &Path) -> WorkerSetup {
    let Some(directory) = library.parent() else {
        return WorkerSetup::Refused {
            path: None,
            reason: "NIR1_GRAPH_EVAL_LIBRARY_PATH".into(),
        };
    };
    let path = directory.join(WORKER_FILE_NAME);
    match state.nir1_graph.configure_worker_path(path.clone()) {
        Ok(()) => WorkerSetup::Configured(path),
        Err(error) => WorkerSetup::Refused {
            path: Some(path),
            reason: format!("{error:#}"),
        },
    }
}

fn registered() -> Option<(Registration, Option<Arc<AppState>>)> {
    let registration = lock(&REGISTRY).clone()?;
    let state = registration.state.upgrade();
    Some((registration, state))
}

fn registered_state() -> napi::Result<Arc<AppState>> {
    registered()
        .and_then(|(_, state)| state)
        .ok_or_else(|| Error::from_reason(NOT_REGISTERED))
}

// ---- the path of the loaded library ----------------------------------------

/// The file the code of this module was mapped from: the `.node` in an
/// evaluation build (the test binary under `cargo test`).
#[cfg(target_os = "linux")]
pub(crate) fn loaded_library_path() -> anyhow::Result<PathBuf> {
    let address = loaded_library_path as *const () as usize;
    let maps = std::fs::read_to_string("/proc/self/maps")?;
    mapping_path_for(&maps, address).ok_or_else(|| anyhow::anyhow!("NIR1_GRAPH_EVAL_LIBRARY_PATH"))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn loaded_library_path() -> anyhow::Result<PathBuf> {
    anyhow::bail!("NIR1_GRAPH_EVAL_LIBRARY_PATH_UNSUPPORTED")
}

/// The path of the `/proc/<pid>/maps` line whose range holds `address`. A
/// mapping without an absolute path, or of a deleted file, gives none.
pub(crate) fn mapping_path_for(maps: &str, address: usize) -> Option<PathBuf> {
    for line in maps.lines() {
        let mut fields = line.splitn(6, ' ');
        let Some(range) = fields.next() else {
            continue;
        };
        let Some((start, end)) = range.split_once('-') else {
            continue;
        };
        let (Ok(start), Ok(end)) = (
            usize::from_str_radix(start, 16),
            usize::from_str_radix(end, 16),
        ) else {
            continue;
        };
        if !(start <= address && address < end) {
            continue;
        }
        // perms, offset, dev, inode, then the padded path.
        let path = fields.nth(4).unwrap_or("").trim_start();
        if !path.starts_with('/') || path.ends_with(" (deleted)") {
            return None;
        }
        return Some(PathBuf::from(path));
    }
    None
}

// ---- the begin records ------------------------------------------------------

struct SampleRecord {
    seq: u64,
    begun_at: Instant,
    returned_at: Instant,
    slot_at_begin: GraphSlotKind,
    cache_occupied_at_begin: bool,
    begin: &'static str,
    reason: Option<GraphUnavailable>,
    ticket: Option<GraphTicketWaiter>,
}

struct SampleLog {
    records: VecDeque<SampleRecord>,
    dropped: u64,
}

impl SampleLog {
    const fn new() -> Self {
        Self {
            records: VecDeque::new(),
            dropped: 0,
        }
    }
}

static SAMPLES: Mutex<SampleLog> = Mutex::new(SampleLog::new());
static NEXT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Taken by `Nir1GraphProductOwner::begin` before admission and finished with
/// its result. Inert for an owner whose gate `register` did not open.
pub(crate) struct BeginProbe(Option<ProbeStart>);

struct ProbeStart {
    seq: u64,
    begun_at: Instant,
    slot: GraphSlotKind,
    cache_occupied: bool,
}

impl BeginProbe {
    pub(crate) fn start(owner: &Nir1GraphProductOwner) -> Self {
        if !owner.publication_open_for_eval() {
            return Self(None);
        }
        let begun_at = Instant::now();
        Self(Some(ProbeStart {
            seq: NEXT_SEQ.fetch_add(1, Ordering::SeqCst),
            begun_at,
            slot: owner.slot_kind_for_eval(),
            cache_occupied: owner.cache_occupied_for_eval(),
        }))
    }

    pub(crate) fn finish(self, result: &GraphBegin) {
        let Some(start) = self.0 else {
            return;
        };
        let returned_at = Instant::now();
        let (begin, reason, ticket) = match result {
            GraphBegin::Pending(ticket) => ("pending", None, Some(ticket.waiter())),
            GraphBegin::Cached(_) => ("cached", None, None),
            GraphBegin::Unavailable(reason) => ("unavailable", Some(*reason), None),
        };
        let mut log = lock(&SAMPLES);
        if log.records.len() == SAMPLE_CAPACITY {
            log.records.pop_front();
            log.dropped += 1;
        }
        log.records.push_back(SampleRecord {
            seq: start.seq,
            begun_at: start.begun_at,
            returned_at,
            slot_at_begin: start.slot,
            cache_occupied_at_begin: start.cache_occupied,
            begin,
            reason,
            ticket,
        });
    }
}

pub(crate) fn slot_name(kind: GraphSlotKind) -> &'static str {
    match kind {
        GraphSlotKind::Empty => "empty",
        GraphSlotKind::Preparing => "preparing",
        GraphSlotKind::Ready => "ready",
        GraphSlotKind::InUse => "in-use",
        GraphSlotKind::Retiring => "retiring",
        GraphSlotKind::Suspended => "suspended",
        GraphSlotKind::Quarantined => "quarantined",
        GraphSlotKind::Closed => "closed",
    }
}

fn disposition_name(use_: GraphTicketUse) -> &'static str {
    match use_ {
        GraphTicketUse::Used => "used",
        GraphTicketUse::Unused => "unused",
        GraphTicketUse::Cancelled => "cancelled",
    }
}

fn ticket_json(waiter: &GraphTicketWaiter) -> Value {
    let begun = clock_ns(waiter.begun_at_for_eval());
    match waiter.settlement_for_eval() {
        None => json!({
            "tTicketNs": begun,
            "settled": false,
            "tSettledNs": null,
            "outcome": null,
            "reason": null,
            "disposition": null,
        }),
        Some((at, reason, disposition)) => json!({
            "tTicketNs": begun,
            "settled": true,
            "tSettledNs": clock_ns(at),
            "outcome": if reason.is_some() { "unavailable" } else { "available" },
            "reason": reason.map(GraphUnavailable::as_str),
            "disposition": disposition.map(disposition_name),
        }),
    }
}

pub(crate) fn samples_json() -> Value {
    let log = lock(&SAMPLES);
    let records: Vec<Value> = log
        .records
        .iter()
        .map(|record| {
            json!({
                "seq": record.seq,
                "tBeginNs": clock_ns(record.begun_at),
                "tReturnedNs": clock_ns(record.returned_at),
                "slotAtBegin": slot_name(record.slot_at_begin),
                "cacheOccupiedAtBegin": record.cache_occupied_at_begin,
                "begin": record.begin,
                "reason": record.reason.map(GraphUnavailable::as_str),
                "ticket": record.ticket.as_ref().map(ticket_json),
            })
        })
        .collect();
    json!({
        "schema": SAMPLES_SCHEMA,
        "dropped": log.dropped,
        "records": records,
        "clockNs": clock_ns(Instant::now()),
    })
}

pub(crate) fn clear_samples() -> usize {
    let mut log = lock(&SAMPLES);
    let cleared = log.records.len();
    log.records.clear();
    log.dropped = 0;
    cleared
}

// ---- status and diagnostics -------------------------------------------------

fn worker_json(worker: &WorkerSetup) -> Value {
    match worker {
        WorkerSetup::Configured(path) => json!({
            "state": "configured",
            "path": path.to_string_lossy(),
            "reason": null,
        }),
        WorkerSetup::Refused { path, reason } => json!({
            "state": "refused",
            "path": path.as_ref().map(|path| path.to_string_lossy()),
            "reason": reason,
        }),
        WorkerSetup::NotAttempted => json!({
            "state": "not-attempted",
            "path": null,
            "reason": null,
        }),
    }
}

pub(crate) fn status_json() -> Value {
    let now = clock_ns(Instant::now());
    let Some((registration, state)) = registered() else {
        return json!({
            "schema": STATUS_SCHEMA,
            "feature": FEATURE,
            "registered": false,
            "clockNs": now,
        });
    };
    let owner = state.as_ref().map(|state| {
        let profile = state.profile_egress.status();
        json!({
            "publicationOpen": state.nir1_graph.publication_is_open(),
            "workerConfigured": state.nir1_graph.worker_configured_for_eval(),
            "slot": slot_name(state.nir1_graph.slot_kind_for_eval()),
            "cacheOccupied": state.nir1_graph.cache_occupied_for_eval(),
            "closed": state.nir1_graph.is_closed(),
            "profile": {
                "restricted": profile.restricted,
                "inFlightStopped": profile.in_flight_stopped,
            },
        })
    });
    json!({
        "schema": STATUS_SCHEMA,
        "feature": FEATURE,
        "registered": true,
        "registrations": registration.registrations,
        "registeredAtNs": clock_ns(registration.registered_at),
        "alive": state.is_some(),
        "worker": worker_json(&registration.worker),
        "owner": owner,
        "workerFileName": WORKER_FILE_NAME,
        "clockNs": now,
    })
}

pub(crate) fn diagnostics_json(state: &AppState) -> Value {
    let d = state.nir1_graph.diagnostics();
    let unavailable: serde_json::Map<String, Value> = GraphUnavailable::ALL
        .iter()
        .zip(d.unavailable.iter())
        .map(|(reason, count)| (reason.as_str().to_owned(), Value::from(*count)))
        .collect();
    json!({
        "schema": DIAGNOSTICS_SCHEMA,
        "begins": d.begins,
        "pending": d.pending,
        "cacheHits": d.cache_hits,
        "unavailable": unavailable,
        "preparesStarted": d.prepares_started,
        "preparesReady": d.prepares_ready,
        "prepareFailures": d.prepare_failures,
        "stamp0Missing": d.stamp0_missing,
        "stampFresh": d.stamp_fresh,
        "stampStale": d.stamp_stale,
        "stampUnavailable": d.stamp_unavailable,
        "driftAtQuery": d.drift_at_query,
        "retiredIdle": d.retired_idle,
        "retiredEdge": d.retired_edge,
        "quarantines": d.quarantines,
        "lateCached": d.late_cached,
        "sceneTotalOverCap": d.scene_total_over_cap,
        "querySceneAssociated": d.query_scene_associated,
        "panics": d.panics,
        "slot": slot_name(state.nir1_graph.slot_kind_for_eval()),
        "cacheOccupied": state.nir1_graph.cache_occupied_for_eval(),
        "clockNs": clock_ns(Instant::now()),
    })
}

// ---- the A3 record ----------------------------------------------------------

pub(crate) fn read_a3_json(
    database: &Path,
    project_id: &str,
    query_scene_id: &str,
    revision_ids: &[String],
) -> anyhow::Result<Value> {
    use grimodex_db::narrative_extraction::nir1_graph_eval::read_a3_read_only;
    let _ = anchor();
    let record = read_a3_read_only(database, project_id, query_scene_id, revision_ids)?;
    let revisions: Vec<Value> = record
        .revisions
        .iter()
        .map(|revision| {
            json!({
                "revisionId": revision.revision_id,
                "a3": if revision.eligible { "eligible" } else { "unavailable" },
                "reason": revision.reason,
            })
        })
        .collect();
    Ok(json!({
        "schema": A3_SCHEMA,
        "connection": "read-only-own",
        "tOpenStartedNs": clock_ns(record.open_started),
        "tSnapshotNs": clock_ns(record.snapshot_at),
        "tFinishedNs": clock_ns(record.finished_at),
        "revisions": revisions,
    }))
}

// ---- the N-API functions (evaluation build only) ------------------------------

/// `{ schema, feature, registered, registrations, alive, worker, owner, clockNs }`.
#[napi(js_name = "nir1GraphEvalStatus")]
pub fn nir1_graph_eval_status() -> napi::Result<String> {
    Ok(status_json().to_string())
}

/// The owner's counters (`GraphOwnerDiagnostics`), the slot and the cache.
#[napi(js_name = "nir1GraphEvalDiagnostics")]
pub fn nir1_graph_eval_diagnostics() -> napi::Result<String> {
    let state = registered_state()?;
    Ok(diagnostics_json(&state).to_string())
}

/// Empties the next-query cache before a K6/2 (a) sample.
#[napi(js_name = "nir1GraphEvalClearNextQueryCache")]
pub fn nir1_graph_eval_clear_next_query_cache() -> napi::Result<String> {
    let state = registered_state()?;
    let cleared = state.nir1_graph.clear_next_query_cache_for_eval();
    Ok(json!({ "cleared": cleared, "clockNs": clock_ns(Instant::now()) }).to_string())
}

/// The `begin` records kept so far (not drained).
#[napi(js_name = "nir1GraphEvalSamples")]
pub fn nir1_graph_eval_samples() -> napi::Result<String> {
    Ok(samples_json().to_string())
}

/// Forgets the `begin` records (and the dropped count).
#[napi(js_name = "nir1GraphEvalClearSamples")]
pub fn nir1_graph_eval_clear_samples() -> napi::Result<String> {
    let cleared = clear_samples();
    Ok(json!({ "cleared": cleared, "clockNs": clock_ns(Instant::now()) }).to_string())
}

/// The eval clock now, in nanoseconds since the anchor.
#[napi(js_name = "nir1GraphEvalClockNs")]
pub fn nir1_graph_eval_clock_ns() -> napi::Result<String> {
    Ok(clock_ns(Instant::now()).to_string())
}

/// The A3 record on a read-only connection of its own (no DB mutex, no
/// participant). `database` is the absolute path of the workspace's
/// `grimodex.db`.
#[napi(js_name = "nir1GraphEvalReadA3")]
pub async fn nir1_graph_eval_read_a3(
    database: String,
    project_id: String,
    query_scene_id: String,
    revision_ids: Vec<String>,
) -> napi::Result<String> {
    napi::tokio::task::spawn_blocking(move || {
        read_a3_json(
            Path::new(&database),
            &project_id,
            &query_scene_id,
            &revision_ids,
        )
    })
    .await
    .map_err(|error| Error::from_reason(format!("{error}")))?
    .map(|value| value.to_string())
    .map_err(|error| Error::from_reason(format!("{error:#}")))
}
