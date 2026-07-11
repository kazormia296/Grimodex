//! Shell-independent semantic command runtime.
//!
//! A shell pins one [`SemanticRequest`] at command start.  The request owns one
//! database `Arc` and one cache epoch `Arc`, so a workspace switch cannot make
//! a long-running read/embed/upsert sequence cross database or cache epochs.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use grimodex_db::events::EventSink;
use grimodex_db::Database;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::chat_index::{collect_chat_index_status, ChatIndexStatus};
use crate::chat_search::ChatSearchCache;
use crate::codex_index::{collect_codex_index_status, CodexIndexStatus};
use crate::codex_search::CodexSearchCache;
use crate::events_index::{collect_events_index_status, EventsIndexStatus};
use crate::events_search::EventsSearchCache;
use crate::index::{
    collect_index_status, count_indexable_scenes, list_unindexed_scene_contents, project_language,
    IndexStatusReport,
};
use crate::preview::{slice_context_verified, PreviewContext};
use crate::search::SearchCache;
use crate::spec::spec_for_language;

#[cfg(feature = "semantic-embedding")]
use crate::chat_index::{
    embed_chat_text, list_message_ids_in_project, project_language_for_chat_message,
    read_chat_message_for_index, upsert_chat_chunk, ChatUpsertOutcome,
};
#[cfg(feature = "semantic-embedding")]
use crate::chat_search::{run_chat_search, ChatSearchHit};
#[cfg(feature = "semantic-embedding")]
use crate::codex_index::{
    embed_codex_text, list_entry_ids_in_project, project_language_for_codex_entry,
    read_codex_for_index, upsert_codex_chunk, CodexUpsertOutcome,
};
#[cfg(feature = "semantic-embedding")]
use crate::codex_search::{run_codex_search, CodexSearchHit};
#[cfg(feature = "semantic-embedding")]
use crate::download;
#[cfg(feature = "semantic-embedding")]
use crate::embedding::Embedder;
#[cfg(feature = "semantic-embedding")]
use crate::events_index::{
    embed_event_text, list_event_ids_in_project, project_language_for_event, read_event_for_index,
    upsert_event_chunk, EventUpsertOutcome,
};
#[cfg(feature = "semantic-embedding")]
use crate::events_search::{run_events_search, EventSearchHit};
#[cfg(feature = "semantic-embedding")]
use crate::index::{
    embed_scene_payloads, list_scene_ids_in_project, project_language_for_scene,
    read_scene_for_index, upsert_scene_chunks, UpsertOutcome,
};
#[cfg(feature = "semantic-embedding")]
use crate::search::{run_search, SearchHit};
#[cfg(feature = "semantic-embedding")]
use crate::spec::EmbeddingModelSpec;
#[cfg(feature = "semantic-embedding")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "semantic-embedding")]
use std::hash::{Hash, Hasher};
#[cfg(feature = "semantic-embedding")]
use std::sync::Condvar;

pub const REINDEX_PROGRESS_EVENT: &str = "semantic:reindex_progress";
pub const MODEL_DOWNLOAD_PROGRESS_EVENT: &str = "semantic:model_download_progress";

#[derive(Debug, Clone)]
pub struct SemanticPaths {
    /// Writable `<appData>/models` directory.
    pub models_root: PathBuf,
    /// Read-only bundled `resources/semantic` directory.
    pub resource_semantic_root: PathBuf,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SemanticReindexProgress {
    pub scene_index: usize,
    pub scene_id: String,
    pub total_scenes: usize,
    pub chunks_indexed: usize,
    pub done: bool,
    /// Backward-compatible discriminator for multi-window/workspace listeners.
    pub project_id: String,
    /// Identifies one frontend-triggered run so stale events cannot mutate a
    /// newer run's toast/progress state.
    pub run_id: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadProgress {
    pub dir_name: String,
    pub downloaded: u64,
    pub total: u64,
    pub done: bool,
    pub error: Option<String>,
}

pub struct SemanticCaches {
    pub scene: SearchCache,
    pub codex: CodexSearchCache,
    pub events: EventsSearchCache,
    pub chat: ChatSearchCache,
}

impl Default for SemanticCaches {
    fn default() -> Self {
        Self {
            scene: SearchCache::new(),
            codex: CodexSearchCache::new(),
            events: EventsSearchCache::new(),
            chat: ChatSearchCache::new(),
        }
    }
}

#[derive(Clone)]
pub struct SemanticEpoch {
    generation: u64,
    caches: Arc<SemanticCaches>,
}

impl SemanticEpoch {
    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn caches(&self) -> &SemanticCaches {
        &self.caches
    }
}

#[derive(Clone)]
pub struct SemanticRequest {
    db: Arc<Database>,
    epoch: SemanticEpoch,
}

impl SemanticRequest {
    pub fn db(&self) -> &Database {
        &self.db
    }

    pub fn database(&self) -> Arc<Database> {
        Arc::clone(&self.db)
    }

    pub fn epoch(&self) -> &SemanticEpoch {
        &self.epoch
    }
}

struct EpochState {
    generation: u64,
    caches: Arc<SemanticCaches>,
}

#[cfg(feature = "semantic-embedding")]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum ReindexDomain {
    Scene,
    Codex,
    Events,
    Chat,
}

#[cfg(feature = "semantic-embedding")]
#[derive(Clone, Debug, Eq)]
struct FlightKey {
    generation: u64,
    domain: ReindexDomain,
    project_id: String,
}

#[cfg(feature = "semantic-embedding")]
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ModelIdentity {
    model_id: String,
    embedding_dim: usize,
    chunker_version: String,
    artifact_sha256: String,
}

#[cfg(feature = "semantic-embedding")]
impl ModelIdentity {
    fn for_spec(spec: &EmbeddingModelSpec) -> Self {
        Self {
            model_id: spec.full_model_id(),
            embedding_dim: spec.embedding_dim,
            chunker_version: spec.chunker_version.to_string(),
            artifact_sha256: spec.artifact_sha256.to_string(),
        }
    }
}

#[cfg(feature = "semantic-embedding")]
impl PartialEq for FlightKey {
    fn eq(&self, other: &Self) -> bool {
        self.generation == other.generation
            && self.domain == other.domain
            && self.project_id == other.project_id
    }
}

#[cfg(feature = "semantic-embedding")]
impl Hash for FlightKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.generation.hash(state);
        self.domain.hash(state);
        self.project_id.hash(state);
    }
}

#[cfg(feature = "semantic-embedding")]
#[derive(Clone)]
enum FlightTerminal {
    Completed(std::result::Result<ReindexOutcome, String>),
    Retry,
}

#[cfg(feature = "semantic-embedding")]
#[derive(Clone, Debug, PartialEq, Eq)]
struct ReindexOutcome {
    chunks_indexed: usize,
    total_items: usize,
    last_item_id: String,
}

#[cfg(feature = "semantic-embedding")]
struct SingleflightCompletion {
    outcome: ReindexOutcome,
    joined_existing: bool,
    leader_run_id: Option<String>,
}

#[cfg(feature = "semantic-embedding")]
struct ReindexFlight {
    result: Mutex<Option<FlightTerminal>>,
    ready: Condvar,
    model: ModelIdentity,
    leader_run_id: Option<String>,
}

#[cfg(feature = "semantic-embedding")]
impl ReindexFlight {
    fn new(model: ModelIdentity, leader_run_id: Option<String>) -> Self {
        Self {
            result: Mutex::new(None),
            ready: Condvar::new(),
            model,
            leader_run_id,
        }
    }
}

#[cfg(feature = "semantic-embedding")]
fn wait_for_reindex_flight(flight: &ReindexFlight) -> Result<FlightTerminal> {
    let mut result = flight
        .result
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    while result.is_none() {
        result = flight
            .ready
            .wait(result)
            .unwrap_or_else(|poison| poison.into_inner());
    }
    result
        .as_ref()
        .cloned()
        .ok_or_else(|| anyhow!("semantic reindex flight woke without a completion result"))
}

pub struct SemanticRuntime {
    paths: SemanticPaths,
    #[cfg_attr(not(feature = "semantic-embedding"), allow(dead_code))]
    events: Arc<dyn EventSink + Send + Sync>,
    epoch: Mutex<EpochState>,
    #[cfg(feature = "semantic-embedding")]
    reindex_flights: Mutex<HashMap<FlightKey, Arc<ReindexFlight>>>,
    #[cfg(feature = "semantic-embedding")]
    embedders: Mutex<HashMap<&'static str, Embedder>>,
    #[cfg(feature = "semantic-embedding")]
    downloads_inflight: Mutex<HashSet<&'static str>>,
}

impl SemanticRuntime {
    pub fn new(paths: SemanticPaths, events: Arc<dyn EventSink + Send + Sync>) -> Self {
        Self {
            paths,
            events,
            epoch: Mutex::new(EpochState {
                generation: 0,
                caches: Arc::new(SemanticCaches::default()),
            }),
            #[cfg(feature = "semantic-embedding")]
            reindex_flights: Mutex::new(HashMap::new()),
            #[cfg(feature = "semantic-embedding")]
            embedders: Mutex::new(HashMap::new()),
            #[cfg(feature = "semantic-embedding")]
            downloads_inflight: Mutex::new(HashSet::new()),
        }
    }

    pub fn paths(&self) -> &SemanticPaths {
        &self.paths
    }

    pub fn snapshot_epoch(&self) -> SemanticEpoch {
        let state = self
            .epoch
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        SemanticEpoch {
            generation: state.generation,
            caches: Arc::clone(&state.caches),
        }
    }

    fn current_generation(&self) -> u64 {
        self.epoch
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .generation
    }

    /// Atomically replace all four caches with a fresh generation.
    ///
    /// Old requests retain their old `Arc<SemanticCaches>`; late puts from an
    /// old task therefore remain unreachable from the new workspace epoch.
    pub fn rotate_workspace_epoch(&self) -> SemanticEpoch {
        let mut state = self
            .epoch
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.generation = state.generation.wrapping_add(1);
        state.caches = Arc::new(SemanticCaches::default());
        SemanticEpoch {
            generation: state.generation,
            caches: Arc::clone(&state.caches),
        }
    }

    /// Pin a consistent database/cache pair without holding the epoch mutex
    /// while the workspace resolver locks `WorkspaceState::inner`.
    ///
    /// `open_workspace_sync` keeps `switching=true` from DB swap through epoch
    /// rotation.  An epoch change between the two snapshots retries; a DB pin
    /// attempted inside the swap window fails closed through the resolver.
    pub fn pin_request<E>(
        &self,
        mut resolve_database: impl FnMut() -> std::result::Result<Arc<Database>, E>,
    ) -> std::result::Result<SemanticRequest, E> {
        loop {
            let epoch = self.snapshot_epoch();
            let db = resolve_database()?;
            if self.current_generation() == epoch.generation {
                return Ok(SemanticRequest { db, epoch });
            }
        }
    }

    #[cfg(feature = "semantic-embedding")]
    fn emit<T: Serialize>(&self, channel: &str, payload: &T) {
        if let Ok(value) = serde_json::to_value(payload) {
            self.events.emit(channel, value);
        }
    }

    #[cfg(feature = "semantic-embedding")]
    #[allow(clippy::too_many_arguments)]
    fn run_reindex_singleflight(
        &self,
        request: &SemanticRequest,
        domain: ReindexDomain,
        project_id: &str,
        requested_spec: &'static EmbeddingModelSpec,
        run_id: Option<&str>,
        mut resolve_current_spec: impl FnMut() -> Result<&'static EmbeddingModelSpec>,
        operation: impl FnOnce(&'static EmbeddingModelSpec) -> Result<ReindexOutcome>,
    ) -> Result<SingleflightCompletion> {
        let key = FlightKey {
            generation: request.epoch.generation,
            domain,
            project_id: project_id.to_string(),
        };
        let mut desired_spec = requested_spec;
        loop {
            let desired_model = ModelIdentity::for_spec(desired_spec);
            let (flight, same_model, leader) = {
                let mut flights = self
                    .reindex_flights
                    .lock()
                    .map_err(|error| anyhow!("semantic reindex registry lock poisoned: {error}"))?;
                match flights.get(&key) {
                    Some(flight) => (Arc::clone(flight), flight.model == desired_model, false),
                    None => {
                        let flight =
                            Arc::new(ReindexFlight::new(desired_model, run_id.map(str::to_owned)));
                        flights.insert(key.clone(), Arc::clone(&flight));
                        (flight, true, true)
                    }
                }
            };

            if !leader {
                let terminal = wait_for_reindex_flight(&flight)?;
                if same_model {
                    match terminal {
                        FlightTerminal::Completed(completed) => {
                            return completed
                                .map(|outcome| SingleflightCompletion {
                                    outcome,
                                    joined_existing: true,
                                    leader_run_id: flight.leader_run_id.clone(),
                                })
                                .map_err(anyhow::Error::msg);
                        }
                        FlightTerminal::Retry => {
                            self.remove_reindex_flight(&key, &flight)?;
                            desired_spec = resolve_current_spec()?;
                            continue;
                        }
                    }
                }

                // A different model must run after the prior model, even when
                // the prior operation failed. Re-resolve after waiting so an
                // obsolete queued request adopts the latest project spec.
                self.remove_reindex_flight(&key, &flight)?;
                desired_spec = resolve_current_spec()?;
                continue;
            }

            // The registry label and actual operation spec must be identical.
            // Project language may have changed while this request was queued;
            // publish Retry without consuming the FnOnce operation, then
            // compete again under the freshly resolved identity.
            let current_spec = match resolve_current_spec() {
                Ok(spec) => spec,
                Err(error) => {
                    let message = error.to_string();
                    self.finish_reindex_flight(
                        &key,
                        &flight,
                        FlightTerminal::Completed(Err(message.clone())),
                    )?;
                    return Err(anyhow::Error::msg(message));
                }
            };
            if ModelIdentity::for_spec(current_spec) != flight.model {
                self.finish_reindex_flight(&key, &flight, FlightTerminal::Retry)?;
                desired_spec = current_spec;
                continue;
            }

            let result = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                operation(current_spec)
            })) {
                Ok(result) => result.map_err(|error| error.to_string()),
                Err(payload) => {
                    let detail = payload
                        .downcast_ref::<&str>()
                        .map(|message| (*message).to_string())
                        .or_else(|| payload.downcast_ref::<String>().cloned())
                        .unwrap_or_else(|| "non-string panic payload".to_string());
                    Err(format!("semantic reindex operation panicked: {detail}"))
                }
            };
            self.finish_reindex_flight(&key, &flight, FlightTerminal::Completed(result.clone()))?;
            return result
                .map(|outcome| SingleflightCompletion {
                    outcome,
                    joined_existing: false,
                    leader_run_id: flight.leader_run_id.clone(),
                })
                .map_err(anyhow::Error::msg);
        }
    }

    #[cfg(feature = "semantic-embedding")]
    fn finish_reindex_flight(
        &self,
        key: &FlightKey,
        flight: &ReindexFlight,
        terminal: FlightTerminal,
    ) -> Result<()> {
        {
            let mut slot = flight
                .result
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            *slot = Some(terminal);
            flight.ready.notify_all();
        }
        self.remove_reindex_flight(key, flight)
    }

    #[cfg(feature = "semantic-embedding")]
    fn remove_reindex_flight(&self, key: &FlightKey, flight: &ReindexFlight) -> Result<()> {
        let mut flights = self
            .reindex_flights
            .lock()
            .map_err(|error| anyhow!("semantic reindex registry lock poisoned: {error}"))?;
        if flights
            .get(key)
            .is_some_and(|registered| std::ptr::eq(registered.as_ref(), flight))
        {
            flights.remove(key);
        }
        Ok(())
    }

    #[cfg(feature = "semantic-embedding")]
    fn emit_joined_scene_completion(
        &self,
        completion: &SingleflightCompletion,
        project_id: &str,
        run_id: &str,
    ) {
        if !completion.joined_existing || completion.leader_run_id.as_deref() == Some(run_id) {
            return;
        }
        self.emit(
            REINDEX_PROGRESS_EVENT,
            &SemanticReindexProgress {
                scene_index: completion.outcome.total_items,
                scene_id: completion.outcome.last_item_id.clone(),
                total_scenes: completion.outcome.total_items,
                chunks_indexed: completion.outcome.chunks_indexed,
                done: true,
                project_id: project_id.to_string(),
                run_id: run_id.to_string(),
            },
        );
    }

    // ---------------------------------------------------------------------
    // Feature-independent, DB-only commands.
    // ---------------------------------------------------------------------

    pub fn semantic_index_status(
        &self,
        request: &SemanticRequest,
        project_id: &str,
    ) -> Result<IndexStatusReport> {
        let db = request.db();
        let language = project_language(db, project_id)?;
        let spec = spec_for_language(&language);
        let mut report = collect_index_status(
            db,
            project_id,
            &spec.full_model_id(),
            spec.embedding_dim,
            spec.chunker_version,
        )?;
        let contents = list_unindexed_scene_contents(db, project_id)?;
        report.nonempty_scene_count =
            report.indexed_scene_count + count_indexable_scenes(&contents, spec);
        Ok(report)
    }

    pub fn codex_index_status(
        &self,
        request: &SemanticRequest,
        project_id: &str,
    ) -> Result<CodexIndexStatus> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        collect_codex_index_status(
            request.db(),
            project_id,
            &spec.full_model_id(),
            spec.embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn events_index_status(
        &self,
        request: &SemanticRequest,
        project_id: &str,
    ) -> Result<EventsIndexStatus> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        collect_events_index_status(
            request.db(),
            project_id,
            &spec.full_model_id(),
            spec.embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn chat_index_status(
        &self,
        request: &SemanticRequest,
        project_id: &str,
    ) -> Result<ChatIndexStatus> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        collect_chat_index_status(
            request.db(),
            project_id,
            &spec.full_model_id(),
            spec.embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn semantic_chunk_context(
        &self,
        request: &SemanticRequest,
        scene_id: &str,
        char_start: usize,
        char_end: usize,
        padding: usize,
    ) -> Result<PreviewContext> {
        let db = request.db();
        let row: Option<(String, String)> = db.with_conn(|connection| {
            Ok(connection
                .query_row(
                    "SELECT content, title FROM tree_nodes WHERE id = ? AND node_type = 'scene'",
                    params![scene_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?)
        })?;
        let indexed_chunk: Option<String> = db.with_conn(|connection| {
            Ok(connection
                .query_row(
                    "SELECT text FROM scene_chunks \
                     WHERE scene_id = ? AND char_start = ? AND char_end = ?",
                    params![scene_id, char_start as i64, char_end as i64],
                    |row| row.get(0),
                )
                .optional()?)
        })?;
        let Some((content_json, scene_title)) = row else {
            return Ok(PreviewContext {
                before: String::new(),
                chunk: String::new(),
                after: String::new(),
                scene_title: String::new(),
            });
        };
        let document: serde_json::Value = serde_json::from_str(&content_json)
            .map_err(|error| anyhow!("scene content JSON parse error: {error}"))?;
        let plain_text = crate::chunker::extract_paragraph_texts(&document).join("\n");
        Ok(slice_context_verified(
            &plain_text,
            char_start,
            char_end,
            padding,
            scene_title,
            indexed_chunk.as_deref(),
        ))
    }

    pub fn semantic_debug_dump(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        scene_id: Option<&str>,
        limit: Option<usize>,
    ) -> Result<DebugDumpReport> {
        let cap = limit.unwrap_or(200).min(2000);
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        let current_model_id = spec.full_model_id();
        request.db().with_conn(|connection| {
            let total_chunks = connection.query_row(
                "SELECT COUNT(*) FROM scene_chunks sc \
                 JOIN tree_nodes tn ON tn.id = sc.scene_id \
                 WHERE tn.project_id = ?1 AND (?2 IS NULL OR sc.scene_id = ?2)",
                params![project_id, scene_id],
                |row| row.get::<_, i64>(0),
            )? as usize;
            let mut statement = connection.prepare(
                "SELECT sc.scene_id, COALESCE(tn.title, ''), sc.chunk_index, \
                        sc.char_start, sc.char_end, sc.dialogue_ratio, sc.text, \
                        sc.model_id, sc.embedding_dim, sc.chunker_version, \
                        sc.content_hash, sc.embedding \
                 FROM scene_chunks sc JOIN tree_nodes tn ON tn.id = sc.scene_id \
                 WHERE tn.project_id = ?1 AND (?2 IS NULL OR sc.scene_id = ?2) \
                 ORDER BY sc.scene_id, sc.chunk_index LIMIT ?3",
            )?;
            let rows = statement.query_map(params![project_id, scene_id, cap as i64], |row| {
                let text: String = row.get(6)?;
                let model_id: String = row.get(7)?;
                let embedding_dim: i64 = row.get(8)?;
                let chunker_version: String = row.get(9)?;
                let blob: Vec<u8> = row.get(11)?;
                Ok(DebugChunkRow {
                    scene_id: row.get(0)?,
                    scene_title: row.get(1)?,
                    chunk_index: row.get(2)?,
                    char_start: row.get(3)?,
                    char_end: row.get(4)?,
                    dialogue_ratio: row.get(5)?,
                    text_preview: text.chars().take(140).collect(),
                    model_id: model_id.clone(),
                    embedding_dim,
                    chunker_version: chunker_version.clone(),
                    content_hash: row.get(10)?,
                    embedding_norm: l2_norm_of_f32_le(&blob),
                    is_stale: model_id != current_model_id
                        || embedding_dim != spec.embedding_dim as i64
                        || chunker_version != spec.chunker_version,
                })
            })?;
            let chunks = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(DebugDumpReport {
                project_id: project_id.to_string(),
                language,
                current_model_id,
                current_embedding_dim: spec.embedding_dim,
                current_chunker_version: spec.chunker_version.to_string(),
                total_chunks,
                returned_chunks: chunks.len(),
                chunks,
            })
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugChunkRow {
    pub scene_id: String,
    pub scene_title: String,
    pub chunk_index: i64,
    pub char_start: i64,
    pub char_end: i64,
    pub dialogue_ratio: f64,
    pub text_preview: String,
    pub model_id: String,
    pub embedding_dim: i64,
    pub chunker_version: String,
    pub content_hash: String,
    pub embedding_norm: f64,
    pub is_stale: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugDumpReport {
    pub project_id: String,
    pub language: String,
    pub current_model_id: String,
    pub current_embedding_dim: usize,
    pub current_chunker_version: String,
    pub total_chunks: usize,
    pub returned_chunks: usize,
    pub chunks: Vec<DebugChunkRow>,
}

fn l2_norm_of_f32_le(blob: &[u8]) -> f64 {
    blob.chunks_exact(4)
        .map(|chunk| {
            let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64;
            value * value
        })
        .sum::<f64>()
        .sqrt()
}

// -------------------------------------------------------------------------
// Embedding and download commands.
// -------------------------------------------------------------------------

#[cfg(feature = "semantic-embedding")]
impl SemanticRuntime {
    fn load_embedder(&self, spec: &'static EmbeddingModelSpec) -> Result<Embedder> {
        let directory = download::resolve_model_dir(&self.paths, spec).ok_or_else(|| {
            anyhow!(
                "embedding model '{}' is not installed (checked bundled resource and on-demand model roots); semantic search unavailable — falling back to full-text search",
                spec.dir_name
            )
        })?;
        Embedder::load(
            &directory.join("model_int8.onnx"),
            &directory.join("tokenizer.json"),
            spec,
        )
    }

    fn with_embedder<T>(
        &self,
        spec: &'static EmbeddingModelSpec,
        operation: impl FnOnce(&mut Embedder) -> Result<T>,
    ) -> Result<T> {
        let mut embedders = self
            .embedders
            .lock()
            .map_err(|error| anyhow!("embedder lock poisoned: {error}"))?;
        if !embedders.contains_key(spec.dir_name) {
            embedders.insert(spec.dir_name, self.load_embedder(spec)?);
        }
        let embedder = embedders
            .get_mut(spec.dir_name)
            .ok_or_else(|| anyhow!("embedder was not retained after loading"))?;
        operation(embedder)
    }

    pub fn semantic_index_scene(&self, request: &SemanticRequest, scene_id: &str) -> Result<usize> {
        let language = project_language_for_scene(request.db(), scene_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let outcome = self.with_embedder(spec, |embedder| {
            index_scene(request.db(), embedder, scene_id, &model_id, spec)
        })?;
        match outcome {
            UpsertOutcome::Indexed(count) => {
                request.epoch.caches.scene.invalidate(scene_id)?;
                Ok(count)
            }
            UpsertOutcome::SkippedHashMismatch | UpsertOutcome::SkippedNotScene => Ok(0),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn semantic_search(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        query: &str,
        limit: usize,
        scene_scope: Option<&str>,
        description_mode: Option<bool>,
    ) -> Result<Vec<SearchHit>> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let (query_embedding, embedding_dim) = self.with_embedder(spec, |embedder| {
            Ok((embedder.embed_query(query)?, embedder.embedding_dim()))
        })?;
        run_search(
            request.db(),
            &request.epoch.caches.scene,
            &query_embedding,
            project_id,
            scene_scope,
            limit,
            description_mode.unwrap_or(false),
            &model_id,
            embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn codex_index_entry(&self, request: &SemanticRequest, entry_id: &str) -> Result<usize> {
        let language = project_language_for_codex_entry(request.db(), entry_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let outcome = self.with_embedder(spec, |embedder| {
            index_codex(request.db(), embedder, entry_id, &model_id, spec)
        })?;
        match outcome {
            CodexUpsertOutcome::Indexed(count) => {
                request.epoch.caches.codex.invalidate(entry_id)?;
                Ok(count)
            }
            CodexUpsertOutcome::SkippedHashMismatch | CodexUpsertOutcome::SkippedMissing => Ok(0),
        }
    }

    pub fn codex_semantic_search(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<CodexSearchHit>> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let (query_embedding, embedding_dim) = self.with_embedder(spec, |embedder| {
            Ok((embedder.embed_query(query)?, embedder.embedding_dim()))
        })?;
        run_codex_search(
            request.db(),
            &request.epoch.caches.codex,
            &query_embedding,
            project_id,
            limit,
            &model_id,
            embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn events_index_entry(&self, request: &SemanticRequest, event_id: &str) -> Result<usize> {
        let language = project_language_for_event(request.db(), event_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let outcome = self.with_embedder(spec, |embedder| {
            index_event(request.db(), embedder, event_id, &model_id, spec)
        })?;
        match outcome {
            EventUpsertOutcome::Indexed(count) => {
                request.epoch.caches.events.invalidate(event_id)?;
                Ok(count)
            }
            EventUpsertOutcome::SkippedHashMismatch | EventUpsertOutcome::SkippedMissing => Ok(0),
        }
    }

    pub fn events_semantic_search(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<EventSearchHit>> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let (query_embedding, embedding_dim) = self.with_embedder(spec, |embedder| {
            Ok((embedder.embed_query(query)?, embedder.embedding_dim()))
        })?;
        run_events_search(
            request.db(),
            &request.epoch.caches.events,
            &query_embedding,
            project_id,
            limit,
            &model_id,
            embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn chat_index_message(&self, request: &SemanticRequest, message_id: &str) -> Result<usize> {
        if read_chat_message_for_index(request.db(), message_id)?.is_none() {
            return Ok(0);
        }
        let language = project_language_for_chat_message(request.db(), message_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let outcome = self.with_embedder(spec, |embedder| {
            index_chat(request.db(), embedder, message_id, &model_id, spec)
        })?;
        match outcome {
            ChatUpsertOutcome::Indexed(count) => {
                request.epoch.caches.chat.invalidate(message_id)?;
                Ok(count)
            }
            ChatUpsertOutcome::SkippedHashMismatch | ChatUpsertOutcome::SkippedMissing => Ok(0),
        }
    }

    pub fn chat_message_search(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ChatSearchHit>> {
        let language = project_language(request.db(), project_id)?;
        let spec = spec_for_language(&language);
        let model_id = spec.full_model_id();
        let (query_embedding, embedding_dim) = self.with_embedder(spec, |embedder| {
            Ok((embedder.embed_query(query)?, embedder.embedding_dim()))
        })?;
        run_chat_search(
            request.db(),
            &request.epoch.caches.chat,
            &query_embedding,
            project_id,
            limit,
            &model_id,
            embedding_dim,
            spec.chunker_version,
        )
    }

    pub fn semantic_reindex_all(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        run_id: Option<&str>,
    ) -> Result<usize> {
        let run_id = match run_id {
            Some(value) if (1..=256).contains(&value.chars().count()) => value.to_string(),
            Some(_) => anyhow::bail!("run_id must contain 1..=256 characters"),
            None => uuid::Uuid::new_v4().to_string(),
        };
        let language = project_language(request.db(), project_id)?;
        let requested_spec = spec_for_language(&language);
        let completion = self.run_reindex_singleflight(
            request,
            ReindexDomain::Scene,
            project_id,
            requested_spec,
            Some(&run_id),
            || {
                let current_language = project_language(request.db(), project_id)?;
                Ok(spec_for_language(&current_language))
            },
            |spec| {
                let model_id = spec.full_model_id();
                let scene_ids = list_scene_ids_in_project(request.db(), project_id)?;
                let total_scenes = scene_ids.len();
                if total_scenes == 0 {
                    self.emit(
                        REINDEX_PROGRESS_EVENT,
                        &SemanticReindexProgress {
                            scene_index: 0,
                            scene_id: String::new(),
                            total_scenes: 0,
                            chunks_indexed: 0,
                            done: true,
                            project_id: project_id.to_string(),
                            run_id: run_id.clone(),
                        },
                    );
                    return Ok(ReindexOutcome {
                        chunks_indexed: 0,
                        total_items: 0,
                        last_item_id: String::new(),
                    });
                }
                self.with_embedder(spec, |embedder| {
                    let mut total = 0_usize;
                    for (index, scene_id) in scene_ids.iter().enumerate() {
                        if let UpsertOutcome::Indexed(count) =
                            index_scene(request.db(), embedder, scene_id, &model_id, spec)?
                        {
                            request.epoch.caches.scene.invalidate(scene_id)?;
                            total += count;
                        }
                        self.emit(
                            REINDEX_PROGRESS_EVENT,
                            &SemanticReindexProgress {
                                scene_index: index + 1,
                                scene_id: scene_id.clone(),
                                total_scenes,
                                chunks_indexed: total,
                                done: index + 1 == total_scenes,
                                project_id: project_id.to_string(),
                                run_id: run_id.clone(),
                            },
                        );
                    }
                    Ok(ReindexOutcome {
                        chunks_indexed: total,
                        total_items: total_scenes,
                        last_item_id: scene_ids.last().cloned().unwrap_or_default(),
                    })
                })
            },
        )?;
        self.emit_joined_scene_completion(&completion, project_id, &run_id);
        Ok(completion.outcome.chunks_indexed)
    }

    pub fn codex_reindex_all(&self, request: &SemanticRequest, project_id: &str) -> Result<usize> {
        let language = project_language(request.db(), project_id)?;
        let requested_spec = spec_for_language(&language);
        let completion = self.run_reindex_singleflight(
            request,
            ReindexDomain::Codex,
            project_id,
            requested_spec,
            None,
            || {
                let current_language = project_language(request.db(), project_id)?;
                Ok(spec_for_language(&current_language))
            },
            |spec| {
                let model_id = spec.full_model_id();
                let ids = list_entry_ids_in_project(request.db(), project_id)?;
                let total_items = ids.len();
                let last_item_id = ids.last().cloned().unwrap_or_default();
                if ids.is_empty() {
                    return Ok(ReindexOutcome {
                        chunks_indexed: 0,
                        total_items,
                        last_item_id,
                    });
                }
                self.with_embedder(spec, |embedder| {
                    let mut total = 0;
                    for id in ids {
                        if let CodexUpsertOutcome::Indexed(count) =
                            index_codex(request.db(), embedder, &id, &model_id, spec)?
                        {
                            request.epoch.caches.codex.invalidate(&id)?;
                            total += count;
                        }
                    }
                    Ok(ReindexOutcome {
                        chunks_indexed: total,
                        total_items,
                        last_item_id,
                    })
                })
            },
        )?;
        Ok(completion.outcome.chunks_indexed)
    }

    pub fn events_reindex_all(&self, request: &SemanticRequest, project_id: &str) -> Result<usize> {
        let language = project_language(request.db(), project_id)?;
        let requested_spec = spec_for_language(&language);
        let completion = self.run_reindex_singleflight(
            request,
            ReindexDomain::Events,
            project_id,
            requested_spec,
            None,
            || {
                let current_language = project_language(request.db(), project_id)?;
                Ok(spec_for_language(&current_language))
            },
            |spec| {
                let model_id = spec.full_model_id();
                let ids = list_event_ids_in_project(request.db(), project_id)?;
                let total_items = ids.len();
                let last_item_id = ids.last().cloned().unwrap_or_default();
                if ids.is_empty() {
                    return Ok(ReindexOutcome {
                        chunks_indexed: 0,
                        total_items,
                        last_item_id,
                    });
                }
                self.with_embedder(spec, |embedder| {
                    let mut total = 0;
                    for id in ids {
                        if let EventUpsertOutcome::Indexed(count) =
                            index_event(request.db(), embedder, &id, &model_id, spec)?
                        {
                            request.epoch.caches.events.invalidate(&id)?;
                            total += count;
                        }
                    }
                    Ok(ReindexOutcome {
                        chunks_indexed: total,
                        total_items,
                        last_item_id,
                    })
                })
            },
        )?;
        Ok(completion.outcome.chunks_indexed)
    }

    pub fn chat_reindex_all(&self, request: &SemanticRequest, project_id: &str) -> Result<usize> {
        let language = project_language(request.db(), project_id)?;
        let requested_spec = spec_for_language(&language);
        let completion = self.run_reindex_singleflight(
            request,
            ReindexDomain::Chat,
            project_id,
            requested_spec,
            None,
            || {
                let current_language = project_language(request.db(), project_id)?;
                Ok(spec_for_language(&current_language))
            },
            |spec| {
                let model_id = spec.full_model_id();
                let ids = list_message_ids_in_project(request.db(), project_id)?;
                let total_items = ids.len();
                let last_item_id = ids.last().cloned().unwrap_or_default();
                if ids.is_empty() {
                    return Ok(ReindexOutcome {
                        chunks_indexed: 0,
                        total_items,
                        last_item_id,
                    });
                }
                self.with_embedder(spec, |embedder| {
                    let mut total = 0;
                    for id in ids {
                        if let ChatUpsertOutcome::Indexed(count) =
                            index_chat(request.db(), embedder, &id, &model_id, spec)?
                        {
                            request.epoch.caches.chat.invalidate(&id)?;
                            total += count;
                        }
                    }
                    Ok(ReindexOutcome {
                        chunks_indexed: total,
                        total_items,
                        last_item_id,
                    })
                })
            },
        )?;
        Ok(completion.outcome.chunks_indexed)
    }

    pub fn semantic_download_model(self: &Arc<Self>, language: &str) -> Result<ModelDownloadStart> {
        let spec = spec_for_language(language);
        if download::is_model_installed(&self.paths, spec) {
            return Ok(ModelDownloadStart::Installed);
        }
        if spec.artifact_url.is_empty() {
            return Ok(ModelDownloadStart::Unavailable);
        }
        let mut inflight = self
            .downloads_inflight
            .lock()
            .map_err(|error| anyhow!("download state lock poisoned: {error}"))?;
        if !inflight.insert(spec.dir_name) {
            return Ok(ModelDownloadStart::Downloading);
        }
        Ok(ModelDownloadStart::Start(ModelDownloadJob {
            runtime: Arc::clone(self),
            spec,
        }))
    }

    pub fn gc_stale_model_dirs(&self) {
        download::gc_stale_model_dirs(&self.paths);
    }
}

#[cfg(feature = "semantic-embedding")]
fn index_scene(
    db: &Database,
    embedder: &mut Embedder,
    scene_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<UpsertOutcome> {
    let Some((content, initial_hash)) = read_scene_for_index(db, scene_id)? else {
        return Ok(UpsertOutcome::SkippedNotScene);
    };
    let payloads = embed_scene_payloads(embedder, scene_id, &content, spec)?;
    upsert_scene_chunks(
        db,
        scene_id,
        &initial_hash,
        &payloads,
        model_id,
        embedder.embedding_dim(),
        spec.chunker_version,
    )
}

#[cfg(feature = "semantic-embedding")]
fn index_codex(
    db: &Database,
    embedder: &mut Embedder,
    entry_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<CodexUpsertOutcome> {
    let Some((text, initial_hash)) = read_codex_for_index(db, entry_id)? else {
        return Ok(CodexUpsertOutcome::SkippedMissing);
    };
    let embedding = embed_codex_text(embedder, &text)?;
    upsert_codex_chunk(
        db,
        entry_id,
        &initial_hash,
        &embedding,
        &text,
        model_id,
        embedder.embedding_dim(),
        spec.chunker_version,
    )
}

#[cfg(feature = "semantic-embedding")]
fn index_event(
    db: &Database,
    embedder: &mut Embedder,
    event_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<EventUpsertOutcome> {
    let Some((text, initial_hash)) = read_event_for_index(db, event_id)? else {
        return Ok(EventUpsertOutcome::SkippedMissing);
    };
    let embedding = embed_event_text(embedder, &text)?;
    upsert_event_chunk(
        db,
        event_id,
        &initial_hash,
        &embedding,
        &text,
        model_id,
        embedder.embedding_dim(),
        spec.chunker_version,
    )
}

#[cfg(feature = "semantic-embedding")]
fn index_chat(
    db: &Database,
    embedder: &mut Embedder,
    message_id: &str,
    model_id: &str,
    spec: &'static EmbeddingModelSpec,
) -> Result<ChatUpsertOutcome> {
    let Some(input) = read_chat_message_for_index(db, message_id)? else {
        return Ok(ChatUpsertOutcome::SkippedMissing);
    };
    let embedding = embed_chat_text(embedder, &input.text)?;
    upsert_chat_chunk(
        db,
        message_id,
        &input.hash,
        &embedding,
        &input.text,
        model_id,
        embedder.embedding_dim(),
        spec.chunker_version,
    )
}

#[cfg(feature = "semantic-embedding")]
pub enum ModelDownloadStart {
    Installed,
    Unavailable,
    Downloading,
    Start(ModelDownloadJob),
}

#[cfg(feature = "semantic-embedding")]
impl ModelDownloadStart {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Unavailable => "unavailable",
            Self::Downloading | Self::Start(_) => "downloading",
        }
    }
}

#[cfg(feature = "semantic-embedding")]
pub struct ModelDownloadJob {
    runtime: Arc<SemanticRuntime>,
    spec: &'static EmbeddingModelSpec,
}

#[cfg(feature = "semantic-embedding")]
impl ModelDownloadJob {
    pub async fn run(self) -> Result<()> {
        let runtime = Arc::clone(&self.runtime);
        let spec = self.spec;
        let progress_runtime = Arc::clone(&runtime);
        let progress = move |payload: ModelDownloadProgress| {
            progress_runtime.emit(MODEL_DOWNLOAD_PROGRESS_EVENT, &payload);
        };
        let result = download::install(&runtime.paths, spec, &progress).await;
        if result.is_ok() {
            if let Ok(mut embedders) = runtime.embedders.lock() {
                embedders.remove(spec.dir_name);
            }
        }
        runtime.emit(
            MODEL_DOWNLOAD_PROGRESS_EVENT,
            &ModelDownloadProgress {
                dir_name: spec.dir_name.to_string(),
                downloaded: if result.is_ok() {
                    spec.artifact_size
                } else {
                    0
                },
                total: spec.artifact_size,
                done: true,
                error: result.as_ref().err().map(ToString::to_string),
            },
        );
        result
    }
}

#[cfg(feature = "semantic-embedding")]
impl Drop for ModelDownloadJob {
    fn drop(&mut self) {
        let mut inflight = self
            .runtime
            .downloads_inflight
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        inflight.remove(self.spec.dir_name);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct RecordingEvents {
        values: Mutex<Vec<(String, serde_json::Value)>>,
    }

    impl EventSink for RecordingEvents {
        fn emit(&self, channel: &str, payload: serde_json::Value) {
            self.values
                .lock()
                .unwrap()
                .push((channel.to_string(), payload));
        }
    }

    fn database(project_id: &str) -> Arc<Database> {
        let db = Database::new(Path::new(":memory:")).unwrap();
        db.migrate().unwrap();
        db.with_conn(|connection| {
            connection.execute(
                "INSERT INTO projects (id, title) VALUES (?1, 'test')",
                params![project_id],
            )?;
            Ok(())
        })
        .unwrap();
        Arc::new(db)
    }

    fn runtime(events: Arc<RecordingEvents>) -> Arc<SemanticRuntime> {
        Arc::new(SemanticRuntime::new(
            SemanticPaths {
                models_root: std::env::temp_dir()
                    .join(format!("grimodex-runtime-models-{}", uuid::Uuid::new_v4())),
                resource_semantic_root: std::env::temp_dir().join(format!(
                    "grimodex-runtime-resources-{}",
                    uuid::Uuid::new_v4()
                )),
            },
            events,
        ))
    }

    #[test]
    fn pin_request_retries_when_epoch_rotates_between_snapshots() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let old_db = database("old");
        let new_db = database("new");
        let calls = AtomicUsize::new(0);
        let request = runtime
            .pin_request(|| {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    runtime.rotate_workspace_epoch();
                    Ok::<_, anyhow::Error>(Arc::clone(&old_db))
                } else {
                    Ok(Arc::clone(&new_db))
                }
            })
            .unwrap();
        assert!(Arc::ptr_eq(&request.db, &new_db));
        assert_eq!(request.epoch.generation(), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn old_epoch_put_is_not_visible_after_rotation() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let old = runtime.snapshot_epoch();
        runtime.rotate_workspace_epoch();
        old.caches
            .scene
            .put(
                "old-scene".to_string(),
                "model".to_string(),
                1,
                "chunker".to_string(),
                Arc::new(Vec::new()),
            )
            .unwrap();
        let current = runtime.snapshot_epoch();
        assert_eq!(old.caches.scene.len(), 1);
        assert!(current.caches.scene.is_empty());
        assert!(!Arc::ptr_eq(&old.caches, &current.caches));
    }

    #[test]
    fn pure_db_commands_build_and_run_without_an_embedder() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        let status = runtime.semantic_index_status(&request, "p1").unwrap();
        assert_eq!(status.indexed_chunk_count, 0);
        assert_eq!(status.nonempty_scene_count, 0);
        assert_eq!(
            runtime
                .codex_index_status(&request, "p1")
                .unwrap()
                .total_entry_count,
            0
        );
        assert_eq!(
            runtime
                .events_index_status(&request, "p1")
                .unwrap()
                .total_event_count,
            0
        );
        assert_eq!(
            runtime
                .chat_index_status(&request, "p1")
                .unwrap()
                .total_message_count,
            0
        );
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn bulk_reindex_is_single_flight_per_epoch_domain_and_project() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for index in 0..2 {
            let runtime = Arc::clone(&runtime);
            let request = request.clone();
            let starts = Arc::clone(&starts);
            let barrier = Arc::clone(&barrier);
            let run_id = format!("run-{index}");
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let completion = runtime
                    .run_reindex_singleflight(
                        &request,
                        ReindexDomain::Scene,
                        "p1",
                        &crate::spec::SPEC_JA,
                        Some(&run_id),
                        || Ok(&crate::spec::SPEC_JA),
                        |_spec| {
                            starts.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            Ok(ReindexOutcome {
                                chunks_indexed: 7,
                                total_items: 3,
                                last_item_id: "s3".to_string(),
                            })
                        },
                    )
                    .unwrap();
                (
                    completion.outcome.chunks_indexed,
                    completion.joined_existing,
                    completion.leader_run_id,
                )
            }));
        }
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(results.iter().all(|result| result.0 == 7));
        assert_eq!(results.iter().filter(|result| result.1).count(), 1);
        assert_eq!(results.iter().filter(|result| !result.1).count(), 1);
        assert_eq!(results[0].2, results[1].2);
        assert_eq!(starts.load(Ordering::SeqCst), 1);
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn different_model_reindex_waits_then_runs_in_all_domains() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();

        for domain in [
            ReindexDomain::Scene,
            ReindexDomain::Codex,
            ReindexDomain::Events,
            ReindexDomain::Chat,
        ] {
            let (started_tx, started_rx) = std::sync::mpsc::channel();
            let release_old = Arc::new((Mutex::new(false), Condvar::new()));
            let active = Arc::new(AtomicUsize::new(0));
            let max_active = Arc::new(AtomicUsize::new(0));
            let operation_count = Arc::new(AtomicUsize::new(0));
            let final_model = Arc::new(Mutex::new(String::new()));

            let spawn_flight = |spec: &'static EmbeddingModelSpec,
                                model_id: &'static str,
                                wait_for_release: bool| {
                let runtime = Arc::clone(&runtime);
                let request = request.clone();
                let started_tx = started_tx.clone();
                let release_old = Arc::clone(&release_old);
                let active = Arc::clone(&active);
                let max_active = Arc::clone(&max_active);
                let operation_count = Arc::clone(&operation_count);
                let final_model = Arc::clone(&final_model);
                std::thread::spawn(move || {
                    runtime.run_reindex_singleflight(
                        &request,
                        domain,
                        "p1",
                        spec,
                        None,
                        || Ok(spec),
                        |_actual_spec| {
                            operation_count.fetch_add(1, Ordering::SeqCst);
                            let now_active = active.fetch_add(1, Ordering::SeqCst) + 1;
                            max_active.fetch_max(now_active, Ordering::SeqCst);
                            started_tx.send(model_id).unwrap();
                            if wait_for_release {
                                let (lock, ready) = &*release_old;
                                let mut released = lock.lock().unwrap();
                                while !*released {
                                    released = ready.wait(released).unwrap();
                                }
                            }
                            *final_model.lock().unwrap() = model_id.to_string();
                            active.fetch_sub(1, Ordering::SeqCst);
                            Ok(ReindexOutcome {
                                chunks_indexed: 1,
                                total_items: 1,
                                last_item_id: model_id.to_string(),
                            })
                        },
                    )
                })
            };

            let old = spawn_flight(&crate::spec::SPEC_JA, "ja", true);
            assert_eq!(
                started_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("old model flight must start"),
                "ja"
            );
            let new = spawn_flight(&crate::spec::SPEC_EN, "en", false);

            assert!(
                started_rx
                    .recv_timeout(std::time::Duration::from_millis(250))
                    .is_err(),
                "{domain:?} ran different model flights concurrently"
            );
            {
                let (lock, ready) = &*release_old;
                *lock.lock().unwrap() = true;
                ready.notify_all();
            }
            assert_eq!(
                started_rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("new model flight must run after old model"),
                "en"
            );
            old.join().unwrap().unwrap();
            new.join().unwrap().unwrap();
            assert_eq!(operation_count.load(Ordering::SeqCst), 2);
            assert_eq!(max_active.load(Ordering::SeqCst), 1);
            assert_eq!(&*final_model.lock().unwrap(), "en");
        }
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn different_model_runs_even_when_prior_flight_failed() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let old_runtime = Arc::clone(&runtime);
        let old_request = request.clone();
        let old_release = Arc::clone(&release);
        let old = std::thread::spawn(move || {
            old_runtime.run_reindex_singleflight(
                &old_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_JA,
                None,
                || Ok(&crate::spec::SPEC_JA),
                |_spec| {
                    started_tx.send("ja").unwrap();
                    let (lock, ready) = &*old_release;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = ready.wait(released).unwrap();
                    }
                    anyhow::bail!("old model failed")
                },
            )
        });
        assert_eq!(
            started_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            "ja"
        );

        let ran_new = Arc::new(AtomicUsize::new(0));
        let new_ran = Arc::clone(&ran_new);
        let new_runtime = Arc::clone(&runtime);
        let new_request = request.clone();
        let new = std::thread::spawn(move || {
            new_runtime.run_reindex_singleflight(
                &new_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_EN,
                None,
                || Ok(&crate::spec::SPEC_EN),
                |_spec| {
                    new_ran.fetch_add(1, Ordering::SeqCst);
                    Ok(ReindexOutcome {
                        chunks_indexed: 1,
                        total_items: 1,
                        last_item_id: "en".to_string(),
                    })
                },
            )
        });
        {
            let (lock, ready) = &*release;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }
        assert!(old.join().unwrap().is_err());
        assert_eq!(new.join().unwrap().unwrap().outcome.last_item_id, "en");
        assert_eq!(ran_new.load(Ordering::SeqCst), 1);
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn obsolete_waiter_never_labels_a_flight_with_the_wrong_actual_spec() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        let current_language = Arc::new(AtomicUsize::new(0)); // 0=ja, 1=en
        let release_old = Arc::new((Mutex::new(false), Condvar::new()));
        let release_second = Arc::new((Mutex::new(false), Condvar::new()));
        let (old_started_tx, old_started_rx) = std::sync::mpsc::channel();
        let (second_started_tx, second_started_rx) = std::sync::mpsc::channel();
        let operation_count = Arc::new(AtomicUsize::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let max_active = Arc::new(AtomicUsize::new(0));
        let final_model = Arc::new(Mutex::new(String::new()));

        let old_runtime = Arc::clone(&runtime);
        let old_request = request.clone();
        let old_release = Arc::clone(&release_old);
        let old_count = Arc::clone(&operation_count);
        let old_active = Arc::clone(&active);
        let old_max = Arc::clone(&max_active);
        let old_final = Arc::clone(&final_model);
        let old_current = Arc::clone(&current_language);
        let old = std::thread::spawn(move || {
            old_runtime.run_reindex_singleflight(
                &old_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_JA,
                None,
                || {
                    Ok(if old_current.load(Ordering::SeqCst) == 0 {
                        &crate::spec::SPEC_JA
                    } else {
                        &crate::spec::SPEC_EN
                    })
                },
                |actual_spec| {
                    old_count.fetch_add(1, Ordering::SeqCst);
                    let now = old_active.fetch_add(1, Ordering::SeqCst) + 1;
                    old_max.fetch_max(now, Ordering::SeqCst);
                    assert_eq!(actual_spec.dir_name, crate::spec::SPEC_JA.dir_name);
                    old_started_tx.send(()).unwrap();
                    let (lock, ready) = &*old_release;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = ready.wait(released).unwrap();
                    }
                    *old_final.lock().unwrap() = "ja".to_string();
                    old_active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ReindexOutcome {
                        chunks_indexed: 1,
                        total_items: 1,
                        last_item_id: "ja-old".to_string(),
                    })
                },
            )
        });
        old_started_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();

        // EN request is accepted while JA is running.
        current_language.store(1, Ordering::SeqCst);
        let en_runtime = Arc::clone(&runtime);
        let en_request = request.clone();
        let en_current = Arc::clone(&current_language);
        let en_count = Arc::clone(&operation_count);
        let en_active = Arc::clone(&active);
        let en_max = Arc::clone(&max_active);
        let en_final = Arc::clone(&final_model);
        let en_release = Arc::clone(&release_second);
        let en = std::thread::spawn(move || {
            en_runtime.run_reindex_singleflight(
                &en_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_EN,
                None,
                || {
                    Ok(if en_current.load(Ordering::SeqCst) == 0 {
                        &crate::spec::SPEC_JA
                    } else {
                        &crate::spec::SPEC_EN
                    })
                },
                |actual_spec| {
                    en_count.fetch_add(1, Ordering::SeqCst);
                    let now = en_active.fetch_add(1, Ordering::SeqCst) + 1;
                    en_max.fetch_max(now, Ordering::SeqCst);
                    let selected = actual_spec.dir_name;
                    second_started_tx.send(selected).unwrap();
                    let (lock, ready) = &*en_release;
                    let mut released = lock.lock().unwrap();
                    while !*released {
                        released = ready.wait(released).unwrap();
                    }
                    *en_final.lock().unwrap() = selected.to_string();
                    en_active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ReindexOutcome {
                        chunks_indexed: 1,
                        total_items: 1,
                        last_item_id: selected.to_string(),
                    })
                },
            )
        });

        // Project toggles back to JA. This request must join the old JA flight;
        // it must not become a third operation after the queued EN-labelled one.
        current_language.store(0, Ordering::SeqCst);
        let ja2_runtime = Arc::clone(&runtime);
        let ja2_request = request.clone();
        let ja2_count = Arc::clone(&operation_count);
        let ja2_current = Arc::clone(&current_language);
        let ja2 = std::thread::spawn(move || {
            ja2_runtime.run_reindex_singleflight(
                &ja2_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_JA,
                None,
                || {
                    Ok(if ja2_current.load(Ordering::SeqCst) == 0 {
                        &crate::spec::SPEC_JA
                    } else {
                        &crate::spec::SPEC_EN
                    })
                },
                |_actual_spec| {
                    ja2_count.fetch_add(1, Ordering::SeqCst);
                    Ok(ReindexOutcome {
                        chunks_indexed: 1,
                        total_items: 1,
                        last_item_id: "unexpected-ja3".to_string(),
                    })
                },
            )
        });

        let key = FlightKey {
            generation: request.epoch.generation,
            domain: ReindexDomain::Scene,
            project_id: "p1".to_string(),
        };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let waiter_count = runtime
                .reindex_flights
                .lock()
                .unwrap()
                .get(&key)
                .map(Arc::strong_count)
                .unwrap_or(0);
            if waiter_count >= 4 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "waiters did not register"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        {
            let (lock, ready) = &*release_old;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }

        // The EN-labelled waiter must discard that obsolete label, register a
        // JA flight, and only then begin its operation with actual JA.
        assert_eq!(
            second_started_rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            crate::spec::SPEC_JA.dir_name
        );

        // Toggle to EN again while the second (actual JA) operation is active.
        // This EN request must wait for JA and then execute actual EN; it must
        // never join merely because the original waiter was labelled EN.
        current_language.store(1, Ordering::SeqCst);
        let en2_runtime = Arc::clone(&runtime);
        let en2_request = request.clone();
        let en2_current = Arc::clone(&current_language);
        let en2_count = Arc::clone(&operation_count);
        let en2_active = Arc::clone(&active);
        let en2_max = Arc::clone(&max_active);
        let en2_final = Arc::clone(&final_model);
        let en2 = std::thread::spawn(move || {
            en2_runtime.run_reindex_singleflight(
                &en2_request,
                ReindexDomain::Scene,
                "p1",
                &crate::spec::SPEC_EN,
                None,
                || {
                    Ok(if en2_current.load(Ordering::SeqCst) == 0 {
                        &crate::spec::SPEC_JA
                    } else {
                        &crate::spec::SPEC_EN
                    })
                },
                |actual_spec| {
                    en2_count.fetch_add(1, Ordering::SeqCst);
                    let now = en2_active.fetch_add(1, Ordering::SeqCst) + 1;
                    en2_max.fetch_max(now, Ordering::SeqCst);
                    *en2_final.lock().unwrap() = actual_spec.dir_name.to_string();
                    en2_active.fetch_sub(1, Ordering::SeqCst);
                    Ok(ReindexOutcome {
                        chunks_indexed: 1,
                        total_items: 1,
                        last_item_id: actual_spec.dir_name.to_string(),
                    })
                },
            )
        });

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let waiter_count = runtime
                .reindex_flights
                .lock()
                .unwrap()
                .get(&key)
                .map(Arc::strong_count)
                .unwrap_or(0);
            if waiter_count >= 3 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "final EN waiter did not register"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        {
            let (lock, ready) = &*release_second;
            *lock.lock().unwrap() = true;
            ready.notify_all();
        }

        old.join().unwrap().unwrap();
        en.join().unwrap().unwrap();
        ja2.join().unwrap().unwrap();
        en2.join().unwrap().unwrap();
        assert_eq!(operation_count.load(Ordering::SeqCst), 3);
        assert_eq!(max_active.load(Ordering::SeqCst), 1);
        assert_eq!(&*final_model.lock().unwrap(), crate::spec::SPEC_EN.dir_name);
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn joined_scene_flight_emits_terminal_for_distinct_follower_run_only() {
        let events = Arc::new(RecordingEvents::default());
        let runtime = runtime(Arc::clone(&events));
        let completion = SingleflightCompletion {
            outcome: ReindexOutcome {
                chunks_indexed: 9,
                total_items: 4,
                last_item_id: "scene-4".to_string(),
            },
            joined_existing: true,
            leader_run_id: Some("leader".to_string()),
        };
        runtime.emit_joined_scene_completion(&completion, "p1", "follower");
        runtime.emit_joined_scene_completion(&completion, "p1", "leader");

        let values = events.values.lock().unwrap();
        assert_eq!(values.len(), 1, "leader run must not get a duplicate done");
        let (_, payload) = &values[0];
        assert_eq!(payload["runId"], "follower");
        assert_eq!(payload["projectId"], "p1");
        assert_eq!(payload["sceneIndex"], 4);
        assert_eq!(payload["totalScenes"], 4);
        assert_eq!(payload["chunksIndexed"], 9);
        assert_eq!(payload["done"], true);
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn singleflight_operation_panic_releases_all_waiters() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let runtime = Arc::clone(&runtime);
            let request = request.clone();
            let starts = Arc::clone(&starts);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                runtime
                    .run_reindex_singleflight(
                        &request,
                        ReindexDomain::Scene,
                        "p1",
                        &crate::spec::SPEC_JA,
                        Some("run"),
                        || Ok(&crate::spec::SPEC_JA),
                        |_spec| {
                            starts.fetch_add(1, Ordering::SeqCst);
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            panic!("synthetic reindex panic")
                        },
                    )
                    .err()
                    .map(|error| error.to_string())
                    .expect("panic must become an error")
            }));
        }
        let errors: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert!(errors
            .iter()
            .all(|error| error.contains("synthetic reindex panic")));
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn zero_scene_reindex_emits_done_with_project_and_run() {
        let events = Arc::new(RecordingEvents::default());
        let runtime = runtime(Arc::clone(&events));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        assert_eq!(
            runtime
                .semantic_reindex_all(&request, "p1", Some("run-1"))
                .unwrap(),
            0
        );
        let values = events.values.lock().unwrap();
        let (_, payload) = values.last().expect("done event");
        assert_eq!(payload["done"], true);
        assert_eq!(payload["totalScenes"], 0);
        assert_eq!(payload["projectId"], "p1");
        assert_eq!(payload["runId"], "run-1");
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn reindex_rejects_empty_and_overlong_run_ids() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let db = database("p1");
        let request = runtime
            .pin_request(|| Ok::<_, anyhow::Error>(Arc::clone(&db)))
            .unwrap();
        assert!(runtime
            .semantic_reindex_all(&request, "p1", Some(""))
            .is_err());
        assert!(runtime
            .semantic_reindex_all(&request, "p1", Some(&"x".repeat(257)))
            .is_err());
    }

    #[cfg(feature = "semantic-embedding")]
    #[test]
    fn dropping_download_job_releases_inflight_slot() {
        let runtime = runtime(Arc::new(RecordingEvents::default()));
        let first = runtime.semantic_download_model("en").unwrap();
        let ModelDownloadStart::Start(job) = first else {
            panic!("first request must own the job")
        };
        assert!(matches!(
            runtime.semantic_download_model("en").unwrap(),
            ModelDownloadStart::Downloading
        ));
        drop(job);
        assert!(matches!(
            runtime.semantic_download_model("en").unwrap(),
            ModelDownloadStart::Start(_)
        ));
    }
}
