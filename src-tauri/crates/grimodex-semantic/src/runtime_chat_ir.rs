//! DR-CHATIR-S1-11 (chat IR S1-A0): the shared-crate side of the chat IR
//! one-shot. No product caller exists yet (S1-A adds the Native command), and
//! nothing here changes an existing API.
//!
//! What differs from `prepare_related_scene_query` / `score_accepted_documents`
//! (the Related Scenes path, left as is):
//!
//! * one deadline for the whole call, observed in every wait: the embedder
//!   admission, the embedder mutex, the audit appends and the scoring loop;
//! * the model is **never loaded**: an embedder that is not resident answers
//!   `EmbedderCold` before anything is audited (a load cannot be interrupted
//!   and may try to fetch files, which would void the deadline);
//! * the project's spec is **given by the caller** for both steps, so neither
//!   step reads the DB (the existing path reads `projects.language` five
//!   times, each acquisition announcing a foreground waiter without a
//!   deadline). The same checks run against the given spec every time;
//! * the audit appends use the waiter-free, deadline-bound acquisition
//!   (`Database::try_append_ai_audit_events_for_scope_until`). The records made
//!   before inference (start, prepared, dispatched) are one batch: not durable
//!   in time means no inference and no IR. The terminal records (after
//!   inference) that cannot be made durable in time are **never used**: the
//!   vector is dropped, no IR is returned, and the records travel with the
//!   result as a [`PendingTerminalAudit`] that the caller writes later, outside
//!   the deadline (user confirmation 2026-11-17, "終端を書けなければ IR を返さない").
//!   A [`ChatIrQuery`] therefore exists only after its terminal record is
//!   durable.

use super::audited_query::SemanticEmbeddingIdentity;
use super::*;
use crate::audit::{
    embedding_output_payload, sha256_hex, ModelArtifactIdentity, SemanticAuditAppender,
    TokenizerIdentity,
};
use grimodex_db::ai_audit::AppendAiAuditEvent;
use std::sync::TryLockError;
use std::time::{Duration, Instant};

/// How long a caller may spend writing the deferred terminal records, counted
/// from the start of [`PendingTerminalAudit::flush_with_budget`]. An initial
/// value (DR-CHATIR-S1-11): the write is waiter-free, so it may take a while
/// under a busy connection, and nothing waits for it.
pub const TERMINAL_BACKFILL_BUDGET: Duration = Duration::from_secs(30);

const RETRY_INTERVAL: Duration = Duration::from_millis(1);

/// Request-local capability for the chat IR. Deliberately **not**
/// [`AuditedSemanticQuery`](super::AuditedSemanticQuery): the existing consumers
/// of that type re-read the DB without a deadline, so a chat IR query must not
/// be passable to them. The latent vector is never exported.
pub struct ChatIrQuery {
    request: SemanticRequest,
    project_id: String,
    input_sha256: String,
    identity: SemanticEmbeddingIdentity,
    audit_execution_id: String,
    vector: Vec<f32>,
}

impl ChatIrQuery {
    pub fn model_identity(&self) -> &SemanticEmbeddingIdentity {
        &self.identity
    }
    pub fn execution_id(&self) -> &str {
        &self.audit_execution_id
    }
    pub fn input_sha256(&self) -> &str {
        &self.input_sha256
    }
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn epoch_generation(&self) -> u64 {
        self.request.epoch.generation
    }
}

/// Why no query is returned. A closed set; the shell maps it to its status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChatIrUnavailable {
    /// The model is not resident. Nothing was loaded and nothing was audited.
    EmbedderCold,
    /// The records before inference could not be made durable in time (the
    /// connection was busy for the whole deadline). No inference ran.
    ConnectionBusy,
    /// The deadline elapsed (waiting for the embedder, before inference, or
    /// while the terminal records could not be written). The vector, if any,
    /// was dropped.
    Timeout,
    /// The inference itself failed. Its terminal record was written or
    /// deferred like any other.
    InferenceFailed,
}

pub enum ChatIrPrepareOutcome {
    /// The terminal record of the inference is durable.
    Query(ChatIrQuery),
    /// No IR. `pending_terminal_audit` carries the terminal records that could
    /// not be written inside the deadline, if any; the caller writes them.
    Unavailable {
        reason: ChatIrUnavailable,
        pending_terminal_audit: Option<PendingTerminalAudit>,
    },
}

impl ChatIrPrepareOutcome {
    fn unavailable(reason: ChatIrUnavailable, appender: &ChatIrAuditAppender) -> Self {
        Self::Unavailable {
            reason,
            pending_terminal_audit: appender.take_pending(),
        }
    }
}

pub enum ChatIrScoreOutcome {
    Scores(Vec<f32>),
    /// The deadline elapsed before every candidate was scored. No partial
    /// scores are returned.
    TimedOut,
}

/// Terminal audit records that were not durable inside the deadline. They keep
/// their event ids and timestamps, so writing them is idempotent (the existing
/// append skips an identical event), and they are written in their original
/// order in one transaction. The owner is whoever received the outcome; it must
/// call [`Self::flush_with_budget`] (or [`Self::flush_until`]). If it cannot and
/// drops this value, the loss is logged (`tracing::error`): the execution stays
/// "dispatched" without a terminal record, like a crash, and its result was
/// never used.
#[must_use = "the terminal audit records must be written (flush_with_budget) or the loss is logged on drop"]
pub struct PendingTerminalAudit {
    db: PinnedWorkspaceDb,
    project_id: Option<String>,
    events: Vec<AppendAiAuditEvent>,
}

impl PendingTerminalAudit {
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    pub fn event_count(&self) -> usize {
        self.events.len()
    }

    pub fn execution_ids(&self) -> Vec<&str> {
        let mut ids: Vec<&str> = Vec::new();
        for event in &self.events {
            if !ids.contains(&event.execution_id.as_str()) {
                ids.push(&event.execution_id);
            }
        }
        ids
    }

    /// Write the records, waiter-free, giving up at `deadline`. `Ok(true)`:
    /// written (nothing is pending any more). `Ok(false)`: the connection was
    /// busy until the deadline; the records stay pending. `Err`: the append
    /// failed; the records stay pending too, and the caller may try again.
    pub fn flush_until(&mut self, deadline: Instant) -> Result<bool> {
        if self.events.is_empty() {
            return Ok(true);
        }
        match self.db.db().try_append_ai_audit_events_for_scope_until(
            self.project_id.as_deref(),
            &self.events,
            deadline,
        )? {
            Some(_) => {
                self.events.clear();
                Ok(true)
            }
            None => Ok(false),
        }
    }

    /// [`Self::flush_until`] with [`TERMINAL_BACKFILL_BUDGET`] from now.
    pub fn flush_with_budget(&mut self) -> Result<bool> {
        self.flush_until(Instant::now() + TERMINAL_BACKFILL_BUDGET)
    }
}

impl Drop for PendingTerminalAudit {
    fn drop(&mut self) {
        if !self.events.is_empty() {
            tracing::error!(
                executions = ?self.execution_ids(),
                events = self.events.len(),
                "chat IR terminal audit records were never written; \
                 the executions stay dispatched without a terminal record (their results were not used)"
            );
        }
    }
}

/// The deadline (or an earlier deferral) kept an append from happening. Returned
/// by the appender so the audit session reports the append as failed; it never
/// leaves this module.
#[derive(Debug)]
struct ChatIrAuditDeferred;

impl std::fmt::Display for ChatIrAuditDeferred {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("chat IR audit append was not durable inside the deadline")
    }
}

impl std::error::Error for ChatIrAuditDeferred {}

fn is_deferral(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<ChatIrAuditDeferred>().is_some())
}

#[derive(Default)]
struct AppenderState {
    /// A batch of this session was already made durable (the pre-inference
    /// records). From then on a failed append is deferred, not lost: its events
    /// are kept for the caller. Before that, a failed append wrote nothing, so
    /// there is nothing to defer.
    started: bool,
    project_id: Option<String>,
    deferred: Vec<AppendAiAuditEvent>,
}

/// The audit appender of one chat IR query: waiter-free, deadline-bound, and
/// order-preserving (once an append is deferred, every later one is deferred
/// behind it instead of overtaking it).
struct ChatIrAuditAppender {
    db: PinnedWorkspaceDb,
    deadline: Instant,
    state: Mutex<AppenderState>,
}

impl ChatIrAuditAppender {
    fn new(db: PinnedWorkspaceDb, deadline: Instant) -> Self {
        Self {
            db,
            deadline,
            state: Mutex::new(AppenderState::default()),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, AppenderState> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn has_deferred(&self) -> bool {
        !self.state().deferred.is_empty()
    }

    fn defer(&self, project_id: Option<&str>, events: &[AppendAiAuditEvent]) {
        let mut state = self.state();
        state.project_id = project_id.map(str::to_owned);
        for event in events {
            if !state
                .deferred
                .iter()
                .any(|existing| existing.event_id == event.event_id)
            {
                state.deferred.push(event.clone());
            }
        }
    }

    fn take_pending(&self) -> Option<PendingTerminalAudit> {
        let mut state = self.state();
        if state.deferred.is_empty() {
            return None;
        }
        Some(PendingTerminalAudit {
            db: Arc::clone(&self.db),
            project_id: state.project_id.take(),
            events: std::mem::take(&mut state.deferred),
        })
    }
}

impl SemanticAuditAppender for ChatIrAuditAppender {
    fn append(&self, project_id: Option<&str>, events: &[AppendAiAuditEvent]) -> Result<()> {
        let (started, behind_a_deferral) = {
            let state = self.state();
            (state.started, !state.deferred.is_empty())
        };
        if behind_a_deferral {
            self.defer(project_id, events);
            return Err(anyhow::Error::new(ChatIrAuditDeferred));
        }
        let attempt = self.db.db().try_append_ai_audit_events_for_scope_until(
            project_id,
            events,
            self.deadline,
        );
        match attempt {
            Ok(Some(_)) => {
                self.state().started = true;
                Ok(())
            }
            Ok(None) => {
                if started {
                    self.defer(project_id, events);
                }
                Err(anyhow::Error::new(ChatIrAuditDeferred))
            }
            Err(error) => {
                if started {
                    self.defer(project_id, events);
                }
                Err(error)
            }
        }
    }
}

// Test seams: wait until the deadline has passed at two instants that are
// otherwise a race against the clock (right after the pre-inference records,
// and right after the inference and its terminal records).
#[cfg(test)]
thread_local! {
    pub(super) static AFTER_START_WAIT_FOR_DEADLINE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
    pub(super) static AFTER_RUN_WAIT_FOR_DEADLINE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn wait_for_deadline_if(
    flag: &'static std::thread::LocalKey<std::cell::Cell<bool>>,
    deadline: Instant,
) {
    if flag.with(std::cell::Cell::get) {
        while Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

/// Outcome of [`with_resident_until`].
pub(super) enum ResidentOutcome<T> {
    Ran(T),
    /// The model is not resident; `operation` did not run and nothing was loaded.
    Cold,
    /// The admission or the embedder mutex was not obtained by the deadline.
    TimedOut,
}

/// Run `operation` on the embedder stored under `key`, only if it is already
/// resident: take the foreground admission (waiting at most until `deadline`),
/// then the embedder map (try-lock until `deadline`), then look. There is no
/// loader parameter on purpose: this function cannot load a model. Generic over
/// the embedder type so the load guard is testable without a model file.
pub(super) fn with_resident_until<E, T>(
    admission: &EmbedderAdmission,
    embedders: &Mutex<HashMap<&'static str, E>>,
    key: &'static str,
    deadline: Instant,
    operation: impl FnOnce(&mut E) -> Result<T>,
) -> Result<ResidentOutcome<T>> {
    let outcome = admission.foreground_until(deadline, || {
        let mut map = loop {
            match embedders.try_lock() {
                Ok(map) => break map,
                Err(TryLockError::WouldBlock) => {
                    if Instant::now() >= deadline {
                        return Ok(ResidentOutcome::TimedOut);
                    }
                    std::thread::sleep(RETRY_INTERVAL);
                }
                Err(TryLockError::Poisoned(error)) => {
                    return Err(anyhow!("embedder lock poisoned: {error}"));
                }
            }
        };
        match map.get_mut(key) {
            None => Ok(ResidentOutcome::Cold),
            Some(embedder) => operation(embedder).map(ResidentOutcome::Ran),
        }
    })?;
    Ok(outcome.unwrap_or(ResidentOutcome::TimedOut))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_chat_ir_query_with(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    project_id: &str,
    spec: &'static EmbeddingModelSpec,
    query: &str,
    raw_limit: usize,
    deadline: Instant,
    model: ModelArtifactIdentity,
    tokenizer: TokenizerIdentity,
    inference: impl FnOnce() -> Result<Vec<f32>>,
) -> Result<ChatIrPrepareOutcome> {
    runtime.ensure_background_request_current(request)?;
    let identity = SemanticEmbeddingIdentity::from_loaded(spec, &model, &tokenizer);
    anyhow::ensure!(identity.matches_spec(spec), "SEMANTIC_QUERY_MODEL_CHANGED");
    let appender = Arc::new(ChatIrAuditAppender::new(request.database(), deadline));
    let started = start_embedding_audit_with_appender(
        Arc::clone(&appender) as Arc<dyn SemanticAuditAppender>,
        request,
        project_id,
        AuditedEmbeddingInput {
            path_id: "semantic_search",
            inference_kind: "embedding.query",
            spec,
            model_artifact_identity: model,
            tokenizer_identity: tokenizer,
            raw_text: query,
            model_prefix: spec.query_prefix,
            metadata: json!({
                "domain": "scene", "sceneScope": null, "descriptionMode": false,
                "requestedLimit": raw_limit,
                "consumer": "chat-ir",
                "sharedConsumers": ["chat-ir"],
            }),
        },
        true,
        false,
    );
    let mut audit = match started {
        Ok(audit) => audit,
        // Nothing was written (one atomic batch), so there is nothing to defer
        // and nothing ran: no inference, no IR.
        Err(error) if is_deferral(&error) => {
            return Ok(ChatIrPrepareOutcome::Unavailable {
                reason: ChatIrUnavailable::ConnectionBusy,
                pending_terminal_audit: None,
            });
        }
        Err(error) => return Err(error),
    };
    #[cfg(test)]
    wait_for_deadline_if(&AFTER_START_WAIT_FOR_DEADLINE, deadline);
    // The records are durable; do not start the model after the deadline. The
    // session is dropped here, which records `execution.cancelled` through the
    // same appender (deferred if it cannot be written in time).
    if Instant::now() >= deadline {
        drop(audit);
        return Ok(ChatIrPrepareOutcome::unavailable(
            ChatIrUnavailable::Timeout,
            &appender,
        ));
    }
    let execution_id = audit.execution_id().to_string();
    let run = audit.dispatch_and_run(
        || {
            let vector = inference()?;
            anyhow::ensure!(
                vector.len() == spec.embedding_dim && vector.iter().all(|v| v.is_finite()),
                "SEMANTIC_QUERY_VECTOR_INVALID"
            );
            Ok(vector)
        },
        |vector| embedding_output_payload(vector),
    );
    drop(audit);
    let vector = match run {
        Ok(vector) => vector,
        // The terminal record could not be made durable inside the deadline:
        // the result is not used (fail-closed) and the record is deferred.
        Err(error) if appender.has_deferred() => {
            let reason = if is_deferral(&error) {
                ChatIrUnavailable::Timeout
            } else {
                ChatIrUnavailable::InferenceFailed
            };
            return Ok(ChatIrPrepareOutcome::unavailable(reason, &appender));
        }
        Err(error) => return Err(error),
    };
    #[cfg(test)]
    wait_for_deadline_if(&AFTER_RUN_WAIT_FOR_DEADLINE, deadline);
    // The terminal records are durable, but a terminal that became durable only
    // after the deadline is late too: the answer is "no IR" whether the records
    // missed the deadline (deferred above) or the whole call did (B: not written
    // inside the deadline means the result is not used). Nothing is pending.
    if Instant::now() >= deadline {
        drop(vector);
        return Ok(ChatIrPrepareOutcome::Unavailable {
            reason: ChatIrUnavailable::Timeout,
            pending_terminal_audit: None,
        });
    }
    let query = ChatIrQuery {
        request: request.clone(),
        project_id: project_id.to_string(),
        input_sha256: sha256_hex(query.as_bytes()),
        identity,
        audit_execution_id: execution_id,
        vector,
    };
    runtime.validate_chat_ir_query_current(&query, spec)?;
    Ok(ChatIrPrepareOutcome::Query(query))
}

/// The scoring loop of `score_accepted_documents`, with `should_stop` asked
/// before every candidate. Same checks, same errors, same arithmetic; `None`
/// means it stopped (no partial scores).
pub(super) fn score_vectors_until(
    query_vector: &[f32],
    embedding_dim: usize,
    vectors: &[&[u8]],
    mut should_stop: impl FnMut() -> bool,
) -> Result<Option<Vec<f32>>> {
    let mut scores = Vec::with_capacity(vectors.len());
    for bytes in vectors {
        if should_stop() {
            return Ok(None);
        }
        anyhow::ensure!(
            bytes.len() == embedding_dim * 4,
            "SEMANTIC_DOCUMENT_VECTOR_INVALID"
        );
        let vector: Vec<f32> = bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        anyhow::ensure!(
            vector.iter().all(|value| value.is_finite()),
            "SEMANTIC_DOCUMENT_VECTOR_INVALID"
        );
        let score = crate::embedding::cosine_similarity(query_vector, &vector);
        anyhow::ensure!(score.is_finite(), "SEMANTIC_DOCUMENT_SCORE_INVALID");
        scores.push(score);
    }
    Ok(Some(scores))
}

impl SemanticRuntime {
    /// Embed `query` for the chat IR (S1-A0). `spec` is the project's model
    /// spec, derived by the caller (its source and freshness are the caller's
    /// responsibility); this function reads no DB row but the audit it appends.
    /// Never loads a model: a model that is not resident is `EmbedderCold`.
    /// Ends by `deadline` plus at most one inference (which cannot be
    /// interrupted) and one audit write.
    pub fn prepare_chat_ir_query(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        spec: &'static EmbeddingModelSpec,
        query: &str,
        raw_limit: usize,
        deadline: Instant,
    ) -> Result<ChatIrPrepareOutcome> {
        self.ensure_background_request_current(request)?;
        let outcome = with_resident_until(
            &self.embedder_admission,
            &self.embedders,
            spec.dir_name,
            deadline,
            |embedder| {
                prepare_chat_ir_query_with(
                    self,
                    request,
                    project_id,
                    spec,
                    query,
                    raw_limit,
                    deadline,
                    embedder.model_artifact_identity().clone(),
                    embedder.tokenizer_identity().clone(),
                    || embedder.embed_query(query),
                )
            },
        )?;
        Ok(match outcome {
            ResidentOutcome::Ran(outcome) => outcome,
            ResidentOutcome::Cold => ChatIrPrepareOutcome::Unavailable {
                reason: ChatIrUnavailable::EmbedderCold,
                pending_terminal_audit: None,
            },
            ResidentOutcome::TimedOut => ChatIrPrepareOutcome::Unavailable {
                reason: ChatIrUnavailable::Timeout,
                pending_terminal_audit: None,
            },
        })
    }

    /// The checks of `validate_audited_query_current`, against the `spec` the
    /// caller gives now instead of a DB read: the epoch generation and cache
    /// identity, and the model identity against `spec`.
    pub fn validate_chat_ir_query_current(
        &self,
        query: &ChatIrQuery,
        spec: &'static EmbeddingModelSpec,
    ) -> Result<()> {
        let current = self.snapshot_epoch();
        anyhow::ensure!(
            current.generation == query.request.epoch.generation
                && Arc::ptr_eq(&current.caches, &query.request.epoch.caches),
            "SEMANTIC_QUERY_STALE"
        );
        anyhow::ensure!(
            query.identity.matches_spec(spec),
            "SEMANTIC_QUERY_MODEL_CHANGED"
        );
        Ok(())
    }

    /// `score_accepted_documents` for a [`ChatIrQuery`], checking `deadline`
    /// before every candidate. Call only with the DB's admitted pool after its
    /// current Index/roster check. Neither takes the embedder nor runs inference
    /// nor reads the DB.
    pub fn score_chat_ir_documents_until(
        &self,
        query: &ChatIrQuery,
        spec: &'static EmbeddingModelSpec,
        identity: &SemanticEmbeddingIdentity,
        vectors: &[&[u8]],
        deadline: Instant,
    ) -> Result<ChatIrScoreOutcome> {
        self.validate_chat_ir_query_current(query, spec)?;
        anyhow::ensure!(&query.identity == identity, "SEMANTIC_QUERY_MODEL_MISMATCH");
        let Some(scores) =
            score_vectors_until(&query.vector, identity.embedding_dim, vectors, || {
                Instant::now() >= deadline
            })?
        else {
            return Ok(ChatIrScoreOutcome::TimedOut);
        };
        self.validate_chat_ir_query_current(query, spec)?;
        Ok(ChatIrScoreOutcome::Scores(scores))
    }
}
