use super::*;
use grimodex_db::narrative_extraction::{GraphWorkControl, GraphWorkStage};
use grimodex_semantic::runtime::{
    Nir1DocumentEmbeddingOutcome, Nir1EmbeddingDocument, SemanticEmbeddingAuditBinding,
    SemanticEmbeddingIdentity,
};

/// DR-IRB-3 (E11): how many reader-caused `Retry` in a row end the build task
/// as `Stopped`. 250 ms × 40 ≒ 10 s, the same length as the renderer's read
/// IPC deadline (`IPC_TIMEOUT_MS`): a transient `BUSY` is waited out for up to
/// that long, and a persistent open failure is not retried forever. User
/// decision of 2026-11-06.
const MAX_CONSECUTIVE_READER_RETRIES: u32 = 40;
const RETRY_DELAY: Duration = Duration::from_millis(250);

pub(super) fn schedule(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
) -> Result<()> {
    schedule_with(
        state,
        request,
        participant,
        project,
        RETRY_DELAY,
        MAX_CONSECUTIVE_READER_RETRIES,
    )
}

fn schedule_with(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
    retry_delay: Duration,
    max_reader_retries: u32,
) -> Result<()> {
    if !current_request(&state, &request)? {
        return Ok(());
    }
    let key = (request.database().identity(), project.clone());
    let generation = request.epoch().generation();
    {
        let mut builds = lock(&state.related_scenes.builds)?;
        if !builds.reserve(key.clone(), generation) {
            return Ok(());
        }
    }
    // Independent of query tickets: closing an old list cannot interrupt a
    // needed index publication. Workspace/model changes still revoke the job.
    let weak_state = Arc::downgrade(&state);
    tokio::spawn(async move {
        // Keep the workspace participant across every retry and blocking
        // build. A transition must observe this task before publishing a
        // replacement authority.
        //
        // Consecutive `Retry` outcomes caused by the dedicated reader
        // (open failure, BUSY, slot taken, unproven close). Local to this
        // task, so a new generation's task counts for itself.
        let mut reader_retry_streak: u32 = 0;
        loop {
            let Some(state) = weak_state.upgrade() else {
                break;
            };
            let work_state = state.clone();
            let work_request = request.clone();
            let work_project = project.clone();
            let work_participant = participant.clone();
            let result = tokio::task::spawn_blocking(move || {
                build_once(&work_state, &work_request, &work_participant, &work_project)
            })
            .await;
            let outcome = match result {
                Ok(Ok(outcome)) => outcome,
                _ => break,
            };
            let (next_streak, verdict) =
                next_reader_retry_streak(reader_retry_streak, &outcome, max_reader_retries);
            reader_retry_streak = next_streak;
            tracing::debug!(target:"grimodex::nir1_index", outcome=outcome.label(),
                reader_retry_streak,"NIR1 build outcome");
            if let StreakVerdict::Stop(reason) = verdict {
                // Logged once: the loop ends here and the reservation below
                // is released (the next `begin` starts a fresh task).
                tracing::warn!(target:"grimodex::nir1_index", identity=key.0, project=%project,
                    ?reason, max_reader_retries,
                    "NIR1 reader retries exhausted; stopping the Related Scenes index build");
                break;
            }
            match outcome {
                BuildOutcome::Ready => {
                    state
                        .events
                        .emit("related-scenes:index-ready", json!({"projectId":project}));
                }
                // Pending Feed work can outlive the originating query. Keep
                // its single workspace-bound rebuild alive until the actual
                // canonical state settles or the pinned runtime is revoked.
                BuildOutcome::Retry | BuildOutcome::ReaderRetry(_) | BuildOutcome::Idle => {}
                BuildOutcome::Stopped => break,
            }
            drop(state);
            tokio::time::sleep(retry_delay).await;
        }
        if let Some(state) = weak_state.upgrade() {
            if let Ok(mut builds) = lock(&state.related_scenes.builds) {
                builds.release(&key, generation);
            };
        }
    });
    Ok(())
}

enum BuildOutcome {
    Ready,
    Retry,
    /// A `Retry` caused by the dedicated reader (DR-IRB-3). Counted against
    /// `MAX_CONSECUTIVE_READER_RETRIES`.
    ReaderRetry(index::NirIndexUnavailableReason),
    Idle,
    Stopped,
}

impl BuildOutcome {
    fn label(&self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Retry => "retry",
            Self::ReaderRetry(_) => "reader-retry",
            Self::Idle => "idle",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StreakVerdict {
    Continue,
    Stop(index::NirIndexUnavailableReason),
}

/// The reader-retry counter: a reader-caused `Retry` adds one and `K` of them
/// in a row stop the task; every other outcome (`Ready`, `Idle`, an ordinary
/// `Retry`) resets it.
fn next_reader_retry_streak(
    streak: u32,
    outcome: &BuildOutcome,
    max_reader_retries: u32,
) -> (u32, StreakVerdict) {
    match outcome {
        BuildOutcome::ReaderRetry(reason) => {
            let streak = streak.saturating_add(1);
            if streak >= max_reader_retries {
                (streak, StreakVerdict::Stop(*reason))
            } else {
                (streak, StreakVerdict::Continue)
            }
        }
        _ => (0, StreakVerdict::Continue),
    }
}

/// E11: reader reasons are either transient (`Retry`, bounded by the streak)
/// or mean the authority is not the file that was admitted (`Stopped`).
fn reader_reason_outcome(reason: index::NirIndexUnavailableReason) -> Option<BuildOutcome> {
    use index::NirIndexUnavailableReason as Reason;
    match reason {
        Reason::ReaderOpenFailed
        | Reason::ReaderBusy
        | Reason::ReaderSlotBusy
        | Reason::ReaderCloseUnproven => Some(BuildOutcome::ReaderRetry(reason)),
        Reason::ReaderIdentityMismatch | Reason::ReaderUnavailableForMemoryDatabase => {
            Some(BuildOutcome::Stopped)
        }
        _ => None,
    }
}

/// The detached Chronicle build is a lifecycle participant, but the
/// participant itself is not a full-roster validation context.  Borrow the
/// exact pinned request and re-check its workspace/generation at every Source
/// page and serialization boundary so a transition or shutdown can interrupt
/// the eligibility read before publication.
pub(super) struct RelatedScenesBuildControl<'a> {
    state: &'a AppState,
    request: &'a SemanticRequest,
    participant: &'a WorkspaceParticipant,
}

impl<'a> RelatedScenesBuildControl<'a> {
    pub(super) fn new(
        state: &'a AppState,
        request: &'a SemanticRequest,
        participant: &'a WorkspaceParticipant,
    ) -> Self {
        RelatedScenesBuildControl {
            state,
            request,
            participant,
        }
    }
}

impl GraphWorkControl for RelatedScenesBuildControl<'_> {
    fn check(&mut self, _stage: GraphWorkStage) -> anyhow::Result<()> {
        use grimodex_db::narrative_extraction::{
            validation_terminated, ValidationTerminationReason,
        };
        if self
            .participant
            .stop_requested()
            .map_err(|error| anyhow!(error.to_string()))?
            || self.state.ws.safe_mode.is_active()
        {
            return Err(validation_terminated(
                ValidationTerminationReason::Cancelled,
                "RELATED_SCENES_INVALIDATED",
            ));
        }
        if self.state.semantic.snapshot_epoch().generation() != self.request.epoch().generation() {
            return Err(validation_terminated(
                ValidationTerminationReason::WorkspaceGenerationChanged,
                "RELATED_SCENES_WORKSPACE_CHANGED",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

fn identity(model: SemanticEmbeddingIdentity) -> index::NirEmbeddingIdentity {
    index::NirEmbeddingIdentity {
        model_id: model.model_id,
        artifact_sha256: model.artifact_sha256,
        tokenizer_sha256: model.tokenizer_sha256,
        embedding_dim: model.embedding_dim,
        chunker_version: model.chunker_version,
    }
}
fn audit(audit: SemanticEmbeddingAuditBinding) -> index::NirEmbeddingAuditBinding {
    index::NirEmbeddingAuditBinding {
        operation_id: audit.operation_id,
        execution_id: audit.execution_id,
    }
}

/// What the reader-side half of one build produced. The plan is consumed
/// immediately; keep it inline rather than boxing it.
#[allow(clippy::large_enum_variant)]
enum Prepared {
    Finished(BuildOutcome),
    Ready {
        plan: index::NirIndexBuildPlan,
        documents: Vec<grimodex_db::narrative_extraction::ChronicleRetrievalDocument>,
    },
}

/// The authority admission and the dedicated-reader prepare of one build
/// (DR-IRB-3). The reader slot permit is taken first and is always either
/// consumed by `with_chronicle_reader` or given back here: no early return
/// leaves it taken unless the reader's close was not proven (E8 (a)).
fn prepare_on_reader(
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<Prepared> {
    let db = request.database();
    let runtime = db.nir_chronicle_index_runtime();
    let Some(permit) = runtime.try_acquire_reader_permit() else {
        return Ok(Prepared::Finished(BuildOutcome::ReaderRetry(
            index::NirIndexUnavailableReason::ReaderSlotBusy,
        )));
    };
    let admission = match db.with_participant_read_transaction(participant, |conn| {
        runtime.chronicle_reader_admission(conn, project, &mut *control)
    }) {
        Ok(index::ChronicleReaderAdmissionRead::Admitted(admission)) => admission,
        Ok(index::ChronicleReaderAdmissionRead::Idle) => {
            permit.release_unused();
            return Ok(Prepared::Finished(BuildOutcome::Idle));
        }
        Ok(index::ChronicleReaderAdmissionRead::Stopped) => {
            permit.release_unused();
            return Ok(Prepared::Finished(BuildOutcome::Stopped));
        }
        Err(error) => {
            permit.release_unused();
            return Err(error);
        }
    };
    if admission.already_usable() {
        permit.release_unused();
        return Ok(Prepared::Finished(BuildOutcome::Idle));
    }
    if !admission.reader_available() {
        // An in-memory authority has no second connection. Stop with a typed
        // reason; never fall back to preparing on the authority silently.
        permit.release_unused();
        return Ok(Prepared::Finished(BuildOutcome::Stopped));
    }
    let prepared = runtime.with_chronicle_reader(permit, &admission, participant, |conn| {
        index::prepare_chronicle_index_build_on_reader(
            conn,
            runtime,
            &admission,
            project,
            &mut *control,
        )
    });
    let prepared = match prepared {
        Ok(prepared) => prepared,
        Err(error) => {
            return match index::chronicle_reader_error_reason(&error)
                .and_then(reader_reason_outcome)
            {
                Some(outcome) => {
                    tracing::debug!(target:"grimodex::nir1_index", error=%error,
                        "NIR1 reader prepare ended without a plan");
                    Ok(Prepared::Finished(outcome))
                }
                None => Err(error),
            }
        }
    };
    Ok(match prepared {
        index::NirIndexBuildRead::Ready { plan, documents } => Prepared::Ready { plan, documents },
        index::NirIndexBuildRead::AlreadyUsable => Prepared::Finished(BuildOutcome::Idle),
        index::NirIndexBuildRead::Unavailable {
            reason: index::NirIndexUnavailableReason::PendingChange,
        } => Prepared::Finished(BuildOutcome::Retry),
        _ => Prepared::Finished(BuildOutcome::Stopped),
    })
}

fn build_once(
    state: &AppState,
    request: &SemanticRequest,
    participant: &WorkspaceParticipant,
    project: &str,
) -> Result<BuildOutcome> {
    let started = Instant::now();
    if !current_request(state, request)? {
        return Ok(BuildOutcome::Stopped);
    }
    let db = request.database();
    let mut control = RelatedScenesBuildControl::new(state, request, participant);
    let (plan, documents) = match prepare_on_reader(request, participant, project, &mut control)? {
        Prepared::Ready { plan, documents } => (plan, documents),
        Prepared::Finished(outcome) => return Ok(outcome),
    };
    let prepared_at = Instant::now();
    let model = identity(
        state
            .semantic
            .nir1_document_embedding_identity_with_control(request, project, || {
                control.check(GraphWorkStage::Row)
            })?,
    );
    let mut outcomes = db.with_participant_read_transaction(participant, |conn| {
        index::read_reusable_chronicle_embeddings(
            conn,
            db.nir_chronicle_index_runtime(),
            &plan,
            &model,
        )
    })?;
    let reused_count = outcomes.len();
    let reused = outcomes
        .iter()
        .map(|outcome| outcome.document().revision_id.clone())
        .collect::<HashSet<_>>();
    let documents = documents
        .into_iter()
        .filter(|doc| !reused.contains(&doc.revision_id))
        .collect::<Vec<_>>();
    let inputs = documents
        .iter()
        .map(|doc| Nir1EmbeddingDocument {
            revision_id: doc.revision_id.clone(),
            envelope_digest: doc.envelope_digest.clone(),
            serializer_ref: doc.serializer_ref.into(),
            serialized_statement: doc.serialized_statement.clone(),
            serialized_statement_digest: doc.serialized_statement_digest.clone(),
        })
        .collect::<Vec<_>>();
    let embedded =
        state
            .semantic
            .embed_nir1_documents_with_control(request, project, &inputs, || {
                control.check(GraphWorkStage::Row)
            })?;
    ensure!(
        documents.len() == embedded.len(),
        "RELATED_SCENES_DOCUMENT_OUTCOME_MISSING"
    );
    let generated = documents
        .into_iter()
        .zip(embedded)
        .map(|(original, outcome)| match outcome {
            Nir1DocumentEmbeddingOutcome::Indexed {
                document,
                embedding,
                identity: model,
                audit_binding,
            } => {
                ensure!(
                    document.revision_id == original.revision_id
                        && document.serialized_statement_digest
                            == original.serialized_statement_digest,
                    "RELATED_SCENES_DOCUMENT_OUTCOME_CHANGED"
                );
                Ok(index::NirEmbeddedDocument::Indexed {
                    document: original,
                    embedding,
                    identity: identity(model),
                    audit_binding: audit(audit_binding),
                })
            }
            Nir1DocumentEmbeddingOutcome::SkippedTokenLimit {
                document,
                limit,
                identity: model,
                audit_binding,
            } => {
                ensure!(
                    document.revision_id == original.revision_id
                        && document.serialized_statement_digest
                            == original.serialized_statement_digest,
                    "RELATED_SCENES_DOCUMENT_OUTCOME_CHANGED"
                );
                Ok(index::NirEmbeddedDocument::SkippedTokenLimit {
                    document: original,
                    identity: identity(model),
                    audit_binding: audit(audit_binding),
                    actual_tokens: limit.actual_tokens,
                    maximum_tokens: limit.maximum_tokens,
                })
            }
        })
        .collect::<Result<Vec<_>>>()?;
    outcomes.extend(generated);
    let embedded_at = Instant::now();
    if !current_request(state, request)? {
        return Ok(BuildOutcome::Stopped);
    }
    let published = index::publish_chronicle_index_build_with_participant(
        &db,
        db.nir_chronicle_index_runtime(),
        plan,
        outcomes,
        &mut control,
        participant,
    )?;
    tracing::debug!(target:"grimodex::nir1_index", prepare_ms=prepared_at.duration_since(started).as_millis(),
        embedding_ms=embedded_at.duration_since(prepared_at).as_millis(),
        publication_ms=embedded_at.elapsed().as_millis(),reused_count,"NIR1 build components");
    match published {
        index::NirIndexPublishRead::Published {
            newly_usable_published: true,
            ..
        } if current_request(state, request)? => Ok(BuildOutcome::Ready),
        index::NirIndexPublishRead::Stale => Ok(BuildOutcome::Retry),
        _ => Ok(BuildOutcome::Stopped),
    }
}

#[cfg(test)]
#[path = "build_tests.rs"]
mod tests;
