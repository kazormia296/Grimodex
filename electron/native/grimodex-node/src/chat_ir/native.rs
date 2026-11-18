//! The real [`Backend`]: three participant reads, the embedding and the
//! scoring of the shared crate (S1-A0).
//!
//! The reads are three, not one, because the embedding appends to the audit on
//! the one connection and so cannot run inside a read transaction (DR-CHATIR-S1-13).
//! Each read starts from the project's language and derives everything it
//! needs from that value; T2 and T3 refuse when it is no longer T1's.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

use grimodex_db::narrative_extraction::nir1_chronicle_index::{
    self as index, NirQualifiedBatch, NirQualifiedRead, NirQuerySnapshot, NirQueryStatusRead,
};
use grimodex_db::narrative_extraction::{
    validation_terminated, GraphWorkControl, GraphWorkStage, ValidationTerminationReason,
};
use grimodex_db::workspace_lifecycle::WorkspaceParticipant;
use grimodex_db::ParticipantSqlOperationBudget;
use grimodex_semantic::runtime::{
    ChatIrPrepareOutcome, ChatIrQuery, ChatIrScoreOutcome, PendingTerminalAudit,
    SemanticEmbeddingIdentity, SemanticRequest,
};

use super::basis::{derive, Basis};
use super::flow::{Backend, FirstRead, Prepared, Selection};
use super::item::{select_items, Candidate};
use super::request::Request;
use super::status::{from_error, from_unavailable, ChatIrStatus};
use crate::state::AppState;

/// How long one SQLite statement of a read may wait for another writer. The
/// call's deadline bounds it further.
const SQL_BUSY_TIMEOUT: Duration = Duration::from_secs(1);

/// Declaration order is the drop order: the pinned request goes before the
/// participant, so that the participant, which shutdown and a transition wait
/// for, is the last of the two to be released.
pub(crate) struct NativeBackend {
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: WorkspaceParticipant,
    stop: Arc<AtomicBool>,
}

impl NativeBackend {
    pub(crate) fn new(
        state: Arc<AppState>,
        request: SemanticRequest,
        participant: WorkspaceParticipant,
    ) -> Self {
        Self {
            state,
            request,
            participant,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    fn budget(&self, deadline: Instant) -> ParticipantSqlOperationBudget {
        ParticipantSqlOperationBudget::new(Arc::clone(&self.stop), deadline, SQL_BUSY_TIMEOUT)
    }

    fn control(&self, deadline: Instant) -> ChatIrControl<'_> {
        ChatIrControl {
            state: &self.state,
            request: &self.request,
            participant: &self.participant,
            deadline,
        }
    }

    /// Why the pinned request is no longer current: a workspace that is closing
    /// or in transition is `workspace-unavailable`; another database or another
    /// epoch is `workspace-changed`.
    fn not_current(&self) -> ChatIrStatus {
        if self.participant.stop_requested().unwrap_or(true) {
            ChatIrStatus::WorkspaceUnavailable
        } else {
            ChatIrStatus::WorkspaceChanged
        }
    }

    /// The pinned request is still the active workspace's and the semantic
    /// epoch it was pinned in (the check Related Scenes makes at each of its
    /// steps).
    fn is_current(&self) -> bool {
        let db = self.request.database();
        let Ok(active) = grimodex_db::state::active_database(&self.state.ws) else {
            return false;
        };
        if !Arc::ptr_eq(&active, &db) {
            return false;
        }
        let generation = self.state.semantic.snapshot_epoch().generation();
        if db
            .nir_chronicle_index_runtime()
            .bind_embedding_generation(generation)
            .is_err()
        {
            return false;
        }
        generation == self.request.epoch().generation()
    }
}

/// The stop, safe-mode and generation checks of the Related Scenes build
/// control, and the call's deadline (an expired deadline is `TimedOut`).
struct ChatIrControl<'a> {
    state: &'a AppState,
    request: &'a SemanticRequest,
    participant: &'a WorkspaceParticipant,
    deadline: Instant,
}

impl GraphWorkControl for ChatIrControl<'_> {
    fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
        if self.participant.stop_requested().unwrap_or(true) || self.state.ws.safe_mode.is_active()
        {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "CHAT_IR_STOPPED",
            ));
        }
        if self.state.semantic.snapshot_epoch().generation() != self.request.epoch().generation() {
            return Err(validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "CHAT_IR_WORKSPACE_CHANGED",
            ));
        }
        if Instant::now() >= self.deadline {
            return Err(validation_terminated(
                ValidationTerminationReason::TimedOut,
                "CHAT_IR_DEADLINE",
            ));
        }
        Ok(())
    }

    fn progress_deadline(&self) -> Option<Instant> {
        Some(self.deadline)
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

/// The project's language, `None` when there is no project row. A macro, not a
/// function: the connection type belongs to a crate this one does not depend
/// on, and the read has to be the same statement in all three reads.
macro_rules! read_language {
    ($conn:expr, $project_id:expr) => {
        $conn.query_row(
            "SELECT (SELECT language FROM projects WHERE id=?1)",
            [$project_id],
            |row| row.get::<_, Option<String>>(0),
        )
    };
}

/// The basis of this read, or the reason the read stops (see [`derive`]).
macro_rules! derive_basis {
    ($conn:expr, $project_id:expr, $first:expr) => {{
        let language = read_language!($conn, $project_id)?;
        match derive(language.as_deref(), $first)? {
            Ok(basis) => basis,
            Err(status) => return Ok(Err(status)),
        }
    }};
}

fn settle<T>(read: anyhow::Result<Option<Result<T, ChatIrStatus>>>) -> Result<T, ChatIrStatus> {
    match read {
        Ok(Some(inner)) => inner,
        Ok(None) => Err(ChatIrStatus::ConnectionBusy),
        Err(error) => Err(from_error(&error)),
    }
}

impl Backend for NativeBackend {
    type Snapshot = NirQuerySnapshot;
    type Batch = NirQualifiedBatch;
    type Query = ChatIrQuery;
    type Pending = PendingTerminalAudit;

    fn first_read(
        &self,
        request: &Request,
        deadline: Instant,
        probe: Duration,
    ) -> Result<FirstRead<NirQuerySnapshot>, ChatIrStatus> {
        if !self.is_current() {
            return Err(self.not_current());
        }
        let db = self.request.database();
        let mut control = self.control(deadline);
        let budget = self.budget(deadline).with_connection_lock_timeout(probe);
        settle(
            db.try_with_participant_read_transaction_until(&self.participant, budget, |conn| {
                let basis = derive_basis!(conn, request.project_id.as_str(), None::<&Basis>);
                let scene_exists: i64 = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tree_nodes WHERE id=?1 AND project_id=?2 \
                     AND node_type='scene' AND archived_at IS NULL)",
                    [
                        request.current_scene_id.as_str(),
                        request.project_id.as_str(),
                    ],
                    |row| row.get(0),
                )?;
                if scene_exists == 0 {
                    return Ok(Err(ChatIrStatus::NoCurrentScene));
                }
                let status = index::read_chronicle_query_status_with_control(
                    conn,
                    db.nir_chronicle_index_runtime(),
                    &request.project_id,
                    &request.current_scene_id,
                    &mut control,
                )?;
                Ok(match status {
                    NirQueryStatusRead::Available {
                        index_usable: true,
                        snapshot: Some(snapshot),
                        ..
                    } => Ok(FirstRead { basis, snapshot }),
                    _ => Err(ChatIrStatus::IndexUnavailable),
                })
            }),
        )
    }

    fn prepare(
        &self,
        request: &Request,
        basis: &Basis,
        deadline: Instant,
    ) -> Result<Prepared<ChatIrQuery, PendingTerminalAudit>, ChatIrStatus> {
        let outcome = self
            .state
            .semantic
            .prepare_chat_ir_query(
                &self.request,
                &request.project_id,
                basis.spec,
                &request.query,
                basis.cap,
                deadline,
            )
            .map_err(|error| from_error(&error))?;
        Ok(match outcome {
            ChatIrPrepareOutcome::Query(query) => Prepared::Query(query),
            ChatIrPrepareOutcome::Unavailable {
                reason,
                pending_terminal_audit,
            } => Prepared::Unavailable {
                status: from_unavailable(reason),
                pending: pending_terminal_audit,
            },
        })
    }

    fn qualify(
        &self,
        request: &Request,
        first: &Basis,
        snapshot: &NirQuerySnapshot,
        deadline: Instant,
    ) -> Result<NirQualifiedBatch, ChatIrStatus> {
        let db = self.request.database();
        let mut control = self.control(deadline);
        settle(db.try_with_participant_read_transaction_until(
            &self.participant,
            self.budget(deadline),
            |conn| {
                derive_basis!(conn, request.project_id.as_str(), Some(first));
                let qualified = index::qualify_chronicle_index_snapshot_with_control(
                    conn,
                    db.nir_chronicle_index_runtime(),
                    snapshot,
                    &mut control,
                )?;
                Ok(match qualified {
                    NirQualifiedRead::Qualified(batch) => Ok(batch),
                    NirQualifiedRead::Unavailable { .. } => Err(ChatIrStatus::IndexUnavailable),
                })
            },
        ))
    }

    fn score(
        &self,
        query: &ChatIrQuery,
        basis: &Basis,
        batch: &NirQualifiedBatch,
        deadline: Instant,
    ) -> Result<Vec<f32>, ChatIrStatus> {
        let Some(model) = batch.model_identity() else {
            // No model identity: only an empty pool is consistent.
            return if batch.documents().is_empty() {
                Ok(Vec::new())
            } else {
                Err(ChatIrStatus::Internal)
            };
        };
        let identity = SemanticEmbeddingIdentity {
            model_id: model.model_id.clone(),
            artifact_sha256: model.artifact_sha256.clone(),
            tokenizer_sha256: model.tokenizer_sha256.clone(),
            embedding_dim: model.embedding_dim,
            chunker_version: model.chunker_version.clone(),
        };
        let vectors: Vec<&[u8]> = batch
            .documents()
            .iter()
            .map(|document| document.embedding())
            .collect();
        match self
            .state
            .semantic
            .score_chat_ir_documents_until(query, basis.spec, &identity, &vectors, deadline)
        {
            Ok(ChatIrScoreOutcome::Scores(scores)) => Ok(scores),
            Ok(ChatIrScoreOutcome::TimedOut) => Err(ChatIrStatus::Timeout),
            Err(error) => Err(from_error(&error)),
        }
    }

    fn select(
        &self,
        request: &Request,
        first: &Basis,
        query: &ChatIrQuery,
        batch: &NirQualifiedBatch,
        scores: Vec<f32>,
        deadline: Instant,
    ) -> Result<Selection, ChatIrStatus> {
        let db = self.request.database();
        let mut control = self.control(deadline);
        let (selection, basis) = settle(db.try_with_participant_read_transaction_until(
            &self.participant,
            self.budget(deadline),
            |conn| {
                let basis = derive_basis!(conn, request.project_id.as_str(), Some(first));
                let mut candidates = Vec::new();
                for (document, score) in batch.documents().iter().zip(scores) {
                    for evidence in document.evidence_handles() {
                        candidates.push(Candidate {
                            score,
                            scene_id: evidence.scene_id(),
                            revision_id: document.revision_id(),
                            evidence_id: evidence.evidence_id(),
                            statement: &document.document().serialized_statement,
                            quote: evidence.excerpt(),
                        });
                    }
                }
                let items = select_items(
                    candidates,
                    basis.floor,
                    basis.cap,
                    batch.generation(),
                    |scene_id| {
                        Ok(conn.query_row(
                            "SELECT (SELECT title FROM tree_nodes WHERE id=?1 AND project_id=?2 \
                             AND archived_at IS NULL)",
                            [scene_id, request.project_id.as_str()],
                            |row| row.get::<_, Option<String>>(0),
                        )?)
                    },
                )?;
                // S1-A2: the event of each returned item (A1) and the request's
                // candidates that the admission rule excludes (A2), read before
                // the validation so that one `validate` covers all three. A
                // failure of either is the transaction's error (`internal`):
                // no item is returned without its event IDs.
                let revision_ids: Vec<String> =
                    items.iter().map(|item| item.revision_id.clone()).collect();
                let event_ids = index::read_chronicle_event_ids_of_revisions(
                    conn,
                    &request.project_id,
                    &revision_ids,
                )?;
                let excluded = index::read_chronicle_excluded_event_ids(
                    conn,
                    batch,
                    &request.chronicle_event_ids,
                )?;
                if !index::validate_chronicle_query_snapshot_with_control(
                    conn,
                    db.nir_chronicle_index_runtime(),
                    batch,
                    &mut control,
                )? {
                    return Ok(Err(ChatIrStatus::IndexUnavailable));
                }
                Ok(Ok((
                    Selection {
                        items,
                        event_ids,
                        excluded,
                    },
                    basis,
                )))
            },
        ))?;
        self.state
            .semantic
            .validate_chat_ir_query_current(query, basis.spec)
            .map_err(|error| from_error(&error))?;
        if !self.is_current() {
            return Err(self.not_current());
        }
        Ok(selection)
    }

    fn stop_requested(&self) -> bool {
        self.participant.stop_requested().unwrap_or(true)
    }

    fn db_identity(&self) -> u64 {
        self.request.database().identity()
    }
}
