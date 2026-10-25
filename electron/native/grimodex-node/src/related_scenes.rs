//! Native request capabilities for the two-result Related Scenes path.
//! Main owns sender identities; persisted source and runtime authority are
//! revalidated here before every result and every Evidence navigation.
use crate::{
    publication_guard::PublicationGuard,
    related_scenes_build_registry::RelatedScenesBuildRegistry,
    related_scenes_context::RelatedScenesSourceContext,
    related_scenes_registry::{RelatedScenesLease, RelatedScenesRegistry, SnapshotEligibility},
    state::AppState,
};
use anyhow::{anyhow, ensure, Result};
use grimodex_db::events::EventSink;
use grimodex_db::narrative_extraction::nir1_chronicle_index::{
    self as index, NirEvidenceHandle, NirQualifiedBatch,
};
use grimodex_db::narrative_extraction::{read_retrieval_scene_source, RetrievalSceneSourceRead};
use grimodex_db::workspace_lifecycle::WorkspaceParticipant;
use grimodex_semantic::runtime::{AuditedSemanticQuery, SemanticRequest};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::Notify;

mod begin;
mod build;
mod graph;
mod graph_response;
mod ranking_policy;
mod scoring;

const CAPACITY: usize = 128;
const TTL: Duration = Duration::from_secs(300);
const RAW_LIMIT: usize = 30;

type Lease = Arc<RelatedScenesLease<Operation>>;
type LeaseOf<T> = Arc<RelatedScenesLease<T>>;

pub(crate) struct RelatedScenesService {
    registry: Mutex<RelatedScenesRegistry<Operation>>,
    builds: Mutex<RelatedScenesBuildRegistry>,
}

impl Default for RelatedScenesService {
    fn default() -> Self {
        Self {
            registry: Mutex::new(RelatedScenesRegistry::new(CAPACITY, TTL)),
            builds: Mutex::new(RelatedScenesBuildRegistry::new(CAPACITY)),
        }
    }
}

struct Operation {
    request: SemanticRequest,
    /// The registry entry and any scoring task keep the captured workspace
    /// participant alive until release/invalidation.  This prevents a
    /// transition from publishing a replacement while the related-scenes
    /// worker still reads the old authority.
    participant: WorkspaceParticipant,
    source: Arc<RelatedScenesSourceContext>,
    query_binding: String,
    original: index::NirQuerySnapshot,
    result: Mutex<OperationResult>,
    completed: Notify,
    /// The Graph query of this operation (CP-3a). Its lifetime is the lease's.
    graph: graph::GraphState,
    /// RS-JOIN: wakes the Graph await when the IR arrives, and orders it after
    /// the IR continues of this operation (DR-RSJ-3, DR-RSJ-4).
    join: graph::IrJoin,
}

/// What the end of an operation lease touches: its Graph slot and the tasks
/// waiting on it. The paths that end a lease (release, owner release,
/// invalidation, a workspace transition, expiry, the hand-over in `begin`) are
/// generic over it, so a test drives each of them with a real Graph ticket and
/// no Chronicle index proof, which only the database crate can build (CP-3a).
trait LeaseEnd {
    fn graph(&self) -> &graph::GraphState;
    fn completed(&self) -> &Notify;
}

impl LeaseEnd for Operation {
    fn graph(&self) -> &graph::GraphState {
        &self.graph
    }

    fn completed(&self) -> &Notify {
        &self.completed
    }
}

#[derive(Default)]
struct OperationResult {
    batch: Option<Arc<NirQualifiedBatch>>,
    query: Option<Arc<AuditedSemanticQuery>>,
    response: Option<Value>,
    navigation: HashMap<String, NirEvidenceHandle>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BeginRequest {
    owner_key: String,
    expected_workspace_path: String,
    project_id: String,
    current_scene_id: String,
    query: String,
    /// The Graph seed Entity the renderer chose (CP-3b). Absent: no Graph.
    #[serde(default)]
    graph_seed_entity_id: Option<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| anyhow!("RELATED_SCENES_RUNTIME_UNAVAILABLE"))
}

fn unavailable(reason: &str) -> Value {
    json!({"status":"unavailable","reason":reason})
}

fn current_request(state: &AppState, request: &SemanticRequest) -> Result<bool> {
    let db = request.database();
    let Ok(active) = grimodex_db::state::active_database(&state.ws) else {
        return Ok(false);
    };
    if !Arc::ptr_eq(&active, &db) {
        return Ok(false);
    }
    let generation = state.semantic.snapshot_epoch().generation();
    db.nir_chronicle_index_runtime()
        .bind_embedding_generation(generation)?;
    Ok(generation == request.epoch().generation())
}

fn current_operation(state: &AppState, lease: &Lease) -> Result<bool> {
    if !lease.snapshot.original_snapshot_usable
        || !lease.snapshot.supported_profile
        || !lease.is_live(Instant::now())
        || !current_request(state, &lease.data.request)?
    {
        return Ok(false);
    }
    let op = &lease.data;
    let (batch, query) = {
        let result = lock(&op.result)?;
        (result.batch.clone(), result.query.clone())
    };
    if query.as_ref().is_some_and(|query| {
        state
            .semantic
            .validate_audited_query_current(query)
            .is_err()
    }) {
        return Ok(false);
    }
    let db = op.request.database();
    let mut control = build::RelatedScenesBuildControl::new(state, &op.request, &op.participant);
    db.with_participant_read_transaction(&op.participant, |conn| {
        let RetrievalSceneSourceRead::Available(source) =
            read_retrieval_scene_source(conn, op.source.project_id(), op.source.scene_id())?
        else {
            return Ok(false);
        };
        if !op.source.matches(&source) {
            return Ok(false);
        }
        match &batch {
            Some(batch) => index::validate_chronicle_bound_batch_with_control(
                conn,
                db.nir_chronicle_index_runtime(),
                &op.original,
                batch,
                &mut control,
            ),
            None => index::validate_chronicle_query_status_snapshot_with_control(
                conn,
                db.nir_chronicle_index_runtime(),
                &op.original,
                &mut control,
            ),
        }
    })
}

fn invalidate(state: &AppState, ticket: &str, lease: &Lease) -> Result<()> {
    if invalidate_from_registry(&state.related_scenes.registry, ticket, lease)? {
        announce_invalidated(state, lease);
    }
    Ok(())
}

/// The UI withdrawal signal of an operation that was invalidated.
fn announce_invalidated(state: &AppState, lease: &Lease) {
    state.events.emit(
        "related-scenes:invalidated",
        json!({"queryBinding":lease.data.query_binding}),
    );
}

fn owned_in<T>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    owner: &str,
    ticket: &str,
) -> Result<Option<LeaseOf<T>>> {
    Ok(lock(registry)?
        .entries()
        .into_iter()
        .find(|(key, entry)| key == ticket && entry.is_owned_by(owner))
        .map(|(_, entry)| entry))
}

impl RelatedScenesService {
    fn owned(&self, owner: &str, ticket: &str) -> Result<Option<Lease>> {
        owned_in(&self.registry, owner, ticket)
    }

    /// Invalidate every registry lease before a workspace transition starts.
    /// The lease owns the participant retained by scoring/query tasks; taking
    /// the entries out of the registry lets those tasks observe cancellation
    /// and release before physical replacement is attempted.
    pub(crate) fn stop_for_workspace_transition(&self) -> Result<usize> {
        stop_every_lease(&self.registry)
    }
}

fn stop_every_lease<T: LeaseEnd>(registry: &Mutex<RelatedScenesRegistry<T>>) -> Result<usize> {
    let entries = lock(registry)?.entries();
    let mut stopped = 0;
    for (ticket, lease) in entries {
        if invalidate_from_registry(registry, &ticket, &lease)? {
            stopped += 1;
        }
    }
    Ok(stopped)
}

/// Every path that invalidates a lease ends here: the registry forgets it,
/// its Graph ticket is cancelled (outside the registry lock) and its waiters
/// wake. `invalidate` adds the UI withdrawal signal.
fn invalidate_from_registry<T: LeaseEnd>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    ticket: &str,
    lease: &LeaseOf<T>,
) -> Result<bool> {
    if lock(registry)?.invalidate(ticket) {
        lease.data.graph().cancel();
        lease.data.completed().notify_waiters();
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Invalidates every lease that is no longer live at `now` and returns them,
/// so the caller can deliver each withdrawal signal. Production has no other
/// sweep: an expired lease stays until this runs (the next `begin`) or a call
/// touches its ticket (DR-CP3A-48).
fn invalidate_expired<T: LeaseEnd>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    now: Instant,
) -> Result<Vec<LeaseOf<T>>> {
    let entries = lock(registry)?.entries();
    let mut expired = Vec::new();
    for (ticket, lease) in entries {
        if !lease.is_live(now) && invalidate_from_registry(registry, &ticket, &lease)? {
            expired.push(lease);
        }
    }
    Ok(expired)
}

pub(crate) use begin::begin;
pub(crate) use graph::graph_continue;

pub(crate) async fn continue_query(
    state: Arc<AppState>,
    owner: String,
    ticket: String,
) -> Result<Value> {
    let Some(lease) = state.related_scenes.owned(&owner, &ticket)? else {
        return Ok(unavailable("cancelled"));
    };
    // DR-RSJ-4: the Graph await of this operation waits until this continue
    // has rechecked and returned its IR.
    let _in_flight = lease.data.join.enter();
    // Register before inspecting the slot: a completion between the check and
    // await must not be lost. The fixed lease lifetime is never extended.
    loop {
        let notified = lease.data.completed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if !lease.is_live(Instant::now()) {
            invalidate(&state, &ticket, &lease)?;
            return Ok(unavailable("expired"));
        }
        let response = lock(&lease.data.result)?.response.clone();
        if let Some(response) = response {
            let current_state = state.clone();
            let current_lease = lease.clone();
            let current = tokio::task::spawn_blocking(move || {
                current_operation(&current_state, &current_lease)
            })
            .await??;
            if !current {
                invalidate(&state, &ticket, &lease)?;
                return Ok(unavailable("invalidated"));
            }
            return Ok(response);
        }
        tokio::select! {_ = notified => {}, _ = tokio::time::sleep(Duration::from_millis(250)) => {}}
    }
}

pub(crate) fn release(state: &AppState, owner: &str, ticket: &str) -> Result<Value> {
    release_from(&state.related_scenes.registry, owner, ticket)?;
    Ok(json!({"status":"released"}))
}

fn release_from<T: LeaseEnd>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    owner: &str,
    ticket: &str,
) -> Result<()> {
    if let Some(lease) = owned_in(registry, owner, ticket)? {
        lock(registry)?.release(ticket, owner);
        // A release is a cancellation of the Graph; only the renderer's
        // explicit `unused` declaration lets a result reach the cache.
        lease.data.graph().cancel();
        lease.data.completed().notify_waiters();
    }
    Ok(())
}

pub(crate) fn release_owner(state: &AppState, owner: &str) -> Result<Value> {
    let released = release_owner_from(&state.related_scenes.registry, owner)?;
    Ok(json!({"releasedOperations":released}))
}

fn release_owner_from<T: LeaseEnd>(
    registry: &Mutex<RelatedScenesRegistry<T>>,
    owner: &str,
) -> Result<usize> {
    let entries = lock(registry)?.entries();
    let released = lock(registry)?.release_owner(owner);
    for (_, lease) in entries {
        if lease.is_owned_by(owner) {
            lease.data.graph().cancel();
            lease.data.completed().notify_waiters();
        }
    }
    Ok(released)
}

pub(crate) fn reconcile(state: &Arc<AppState>) -> Result<Value> {
    let entries = lock(&state.related_scenes.registry)?.entries();
    let mut active = 0;
    for (ticket, lease) in entries {
        if current_operation(state, &lease).unwrap_or(false) {
            active += 1;
            continue;
        }
        invalidate(state, &ticket, &lease)?;
        if current_request(state, &lease.data.request)? {
            build::schedule(
                state.clone(),
                lease.data.request.clone(),
                lease.data.participant.clone(),
                lease.data.source.project_id().into(),
            )?;
        }
    }
    Ok(json!({"activeOperations":active}))
}

pub(crate) fn qualify_evidence(state: &AppState, owner: &str, identity: &str) -> Result<Value> {
    let entries = lock(&state.related_scenes.registry)?.entries();
    for (ticket, lease) in entries {
        if !lease.is_owned_by(owner) {
            continue;
        }
        let handle = lock(&lease.data.result)?.navigation.get(identity).cloned();
        let Some(handle) = handle else {
            // A Graph-only row of the Graph answer (CP-3a): its own arm, with
            // its own requalification. Whatever fails there is `unavailable`
            // for this row; the operation is invalidated only when it is
            // itself stale.
            if let Some(entry) = lease.data.graph.click_entry(identity) {
                return graph_response::click(state, &ticket, &lease, identity, &entry);
            }
            continue;
        };
        if !current_operation(state, &lease)? {
            invalidate(state, &ticket, &lease)?;
            return Ok(unavailable("invalidated"));
        }
        let db = lease.data.request.database();
        let mut control = build::RelatedScenesBuildControl::new(
            state,
            &lease.data.request,
            &lease.data.participant,
        );
        let result = db.with_participant_read_transaction(&lease.data.participant, |conn| {
            index::read_chronicle_evidence_navigation_with_control(
                conn,
                db.nir_chronicle_index_runtime(),
                &handle,
                &mut control,
            )
        })?;
        let index::NirEvidenceNavigationRead::Available(result) = result else {
            return Ok(unavailable("invalidated"));
        };
        if !lease.is_live(Instant::now()) || !current_request(state, &lease.data.request)? {
            return Ok(unavailable("invalidated"));
        }
        return Ok(
            json!({"status":"qualified","bindingKey":identity,"queryBinding":lease.data.query_binding,
            "sceneId":result.scene_id,"sourceVersion":result.source_binding.source_version,
            "storageDigest":result.source_binding.storage_digest,"canonicalTextDigest":result.source_binding.canonical_text_digest,
            "normalizerVersion":result.source_binding.normalizer_version,"fullQuote":result.quote,
            "canonicalRange":{"start":result.start_utf16,"end":result.end_utf16}}),
        );
    }
    Ok(unavailable("cancelled"))
}
