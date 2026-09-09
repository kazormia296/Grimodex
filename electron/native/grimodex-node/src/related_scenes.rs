//! Native request capabilities for the two-result Related Scenes path.
//! Main owns sender identities; persisted source and runtime authority are
//! revalidated here before every result and every Evidence navigation.
use crate::{
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
mod ranking_policy;
mod scoring;

const CAPACITY: usize = 128;
const TTL: Duration = Duration::from_secs(300);
const RAW_LIMIT: usize = 30;

type Lease = Arc<RelatedScenesLease<Operation>>;

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
    source: Arc<RelatedScenesSourceContext>,
    query_binding: String,
    original: index::NirQuerySnapshot,
    result: Mutex<OperationResult>,
    completed: Notify,
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
    db.with_read_transaction(|conn| {
        let RetrievalSceneSourceRead::Available(source) =
            read_retrieval_scene_source(conn, op.source.project_id(), op.source.scene_id())?
        else {
            return Ok(false);
        };
        if !op.source.matches(&source) {
            return Ok(false);
        }
        match &batch {
            Some(batch) => index::validate_chronicle_bound_batch(
                conn,
                db.nir_chronicle_index_runtime(),
                &op.original,
                batch,
            ),
            None => index::validate_chronicle_query_status_snapshot(
                conn,
                db.nir_chronicle_index_runtime(),
                &op.original,
            ),
        }
    })
}

fn invalidate(state: &AppState, ticket: &str, lease: &Lease) -> Result<()> {
    if lock(&state.related_scenes.registry)?.invalidate(ticket) {
        lease.data.completed.notify_waiters();
        state.events.emit(
            "related-scenes:invalidated",
            json!({"queryBinding":lease.data.query_binding}),
        );
    }
    Ok(())
}

impl RelatedScenesService {
    fn owned(&self, owner: &str, ticket: &str) -> Result<Option<Lease>> {
        Ok(lock(&self.registry)?
            .entries()
            .into_iter()
            .find(|(key, entry)| key == ticket && entry.is_owned_by(owner))
            .map(|(_, entry)| entry))
    }
}

pub(crate) use begin::begin;

pub(crate) async fn continue_query(
    state: Arc<AppState>,
    owner: String,
    ticket: String,
) -> Result<Value> {
    let Some(lease) = state.related_scenes.owned(&owner, &ticket)? else {
        return Ok(unavailable("cancelled"));
    };
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
    if let Some(lease) = state.related_scenes.owned(owner, ticket)? {
        lock(&state.related_scenes.registry)?.release(ticket, owner);
        lease.data.completed.notify_waiters();
    }
    Ok(json!({"status":"released"}))
}

pub(crate) fn release_owner(state: &AppState, owner: &str) -> Result<Value> {
    let entries = lock(&state.related_scenes.registry)?.entries();
    let released = lock(&state.related_scenes.registry)?.release_owner(owner);
    for (_, lease) in entries {
        if lease.is_owned_by(owner) {
            lease.data.completed.notify_waiters();
        }
    }
    Ok(json!({"releasedOperations":released}))
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
            continue;
        };
        if !current_operation(state, &lease)? {
            invalidate(state, &ticket, &lease)?;
            return Ok(unavailable("invalidated"));
        }
        let db = lease.data.request.database();
        let result = db.with_read_transaction(|conn| {
            index::read_chronicle_evidence_navigation(
                conn,
                db.nir_chronicle_index_runtime(),
                &handle,
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
