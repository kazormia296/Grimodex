use super::*;
use grimodex_semantic::runtime::{
    Nir1DocumentEmbeddingOutcome, Nir1EmbeddingDocument, SemanticEmbeddingAuditBinding,
    SemanticEmbeddingIdentity,
};

pub(super) fn schedule(
    state: Arc<AppState>,
    request: SemanticRequest,
    participant: grimodex_db::workspace_lifecycle::WorkspaceParticipant,
    project: String,
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
        let _participant = participant;
        loop {
            let Some(state) = weak_state.upgrade() else {
                break;
            };
            let work_state = state.clone();
            let work_request = request.clone();
            let work_project = project.clone();
            let result = tokio::task::spawn_blocking(move || {
                build_once(&work_state, &work_request, &work_project)
            })
            .await;
            match result {
                Ok(Ok(BuildOutcome::Ready)) => {
                    state
                        .events
                        .emit("related-scenes:index-ready", json!({"projectId":project}));
                }
                // Pending Feed work can outlive the originating query. Keep
                // its single workspace-bound rebuild alive until the actual
                // canonical state settles or the pinned runtime is revoked.
                Ok(Ok(BuildOutcome::Retry | BuildOutcome::Idle)) => {}
                _ => break,
            }
            drop(state);
            tokio::time::sleep(Duration::from_millis(250)).await;
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
    Idle,
    Stopped,
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

fn build_once(state: &AppState, request: &SemanticRequest, project: &str) -> Result<BuildOutcome> {
    let started = Instant::now();
    if !current_request(state, request)? {
        return Ok(BuildOutcome::Stopped);
    }
    let db = request.database();
    match db.with_read_transaction(|conn| {
        db.nir_chronicle_index_runtime()
            .rebuild_requested(conn, project)
    })? {
        Some(false) => return Ok(BuildOutcome::Idle),
        None => return Ok(BuildOutcome::Stopped),
        Some(true) => {}
    }
    let prepared = db.with_read_transaction(|conn| {
        index::prepare_chronicle_index_build(conn, db.nir_chronicle_index_runtime(), project)
    })?;
    let (plan, documents) = match prepared {
        index::NirIndexBuildRead::Ready { plan, documents } => (plan, documents),
        index::NirIndexBuildRead::AlreadyUsable => return Ok(BuildOutcome::Idle),
        index::NirIndexBuildRead::Unavailable {
            reason: index::NirIndexUnavailableReason::PendingChange,
        } => return Ok(BuildOutcome::Retry),
        _ => return Ok(BuildOutcome::Stopped),
    };
    let prepared_at = Instant::now();
    let model = identity(
        state
            .semantic
            .nir1_document_embedding_identity(request, project)?,
    );
    let mut outcomes = db.with_read_transaction(|conn| {
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
    let embedded = state
        .semantic
        .embed_nir1_documents(request, project, &inputs)?;
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
    let published = index::publish_chronicle_index_build(
        &db,
        db.nir_chronicle_index_runtime(),
        plan,
        outcomes,
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
