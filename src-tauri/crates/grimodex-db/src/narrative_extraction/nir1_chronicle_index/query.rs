use std::sync::Arc;

use anyhow::{ensure, Result};
use rusqlite::Connection;

use super::super::nir1_entity_relation_index::GraphWorkControl;
use super::super::retrieval_admission::{
    read_retrieval_query_context, read_retrieval_scene_source, ChronicleRetrievalDocument,
    QueryIdentityState, RetrievalQueryContext, RetrievalQueryContextRead,
    RetrievalSceneSourceBinding, RetrievalSceneSourceRead,
};
use super::{
    canonical::{proof_current, proof_current_with_control},
    evidence::exact_utf16_quote,
    runtime::IndexProof,
    NirChronicleIndexRuntime, NirEmbeddingIdentity, NirIndexUnavailableReason as Reason,
};

#[derive(Clone, Debug, Eq, PartialEq)]
struct QueryBinding {
    project: String,
    scene: String,
    reading_rank: u64,
    mode: String,
    axis: &'static str,
    fallback: Option<String>,
    identities: [QueryIdentityState; 8],
    allow_secrets: bool,
    scope_key: String,
    scope_token: String,
    source: RetrievalSceneSourceBinding,
}

impl From<&RetrievalQueryContext> for QueryBinding {
    fn from(query: &RetrievalQueryContext) -> Self {
        Self {
            project: query.project_id.clone(),
            scene: query.query_scene_id.clone(),
            reading_rank: query.query_reading_rank,
            mode: query.phase_resolution_mode.clone(),
            axis: query.effective_axis,
            fallback: query.axis_fallback_reason.clone(),
            identities: [
                query.audience.clone(),
                query.viewpoint.clone(),
                query.knowledge_holder.clone(),
                query.timeline.clone(),
                query.worldline.clone(),
                query.narrative_layer.clone(),
                query.reading_order.clone(),
                query.story_time.clone(),
            ],
            allow_secrets: query.allow_secrets,
            scope_key: query.scope_authority_source_key.clone(),
            scope_token: query.scope_authority_revision_token.clone(),
            source: query.query_source.clone(),
        }
    }
}

pub struct NirQualifiedBatch {
    owner: u64,
    proof: Arc<IndexProof>,
    query: RetrievalQueryContext,
    documents: Vec<NirQualifiedDocument>,
}

pub struct NirQualifiedDocument {
    proof: Arc<IndexProof>,
    candidate: usize,
    evidence: Vec<NirEvidenceHandle>,
}

/// Clone is only for the Native operation registry. Neither fields nor a
/// constructor nor serialization cross the renderer/IPC boundary.
#[derive(Clone)]
pub struct NirEvidenceHandle {
    owner: u64,
    proof: Arc<IndexProof>,
    query: QueryBinding,
    candidate: usize,
    evidence: usize,
}

impl NirQualifiedBatch {
    pub fn documents(&self) -> &[NirQualifiedDocument] {
        &self.documents
    }
    pub fn model_identity(&self) -> Option<&NirEmbeddingIdentity> {
        self.proof.model.as_ref()
    }
    pub fn generation(&self) -> i64 {
        self.proof.binding.generation
    }
    pub fn project_id(&self) -> &str {
        &self.proof.project
    }
    pub fn query_context(&self) -> &RetrievalQueryContext {
        &self.query
    }
}

impl NirQualifiedDocument {
    pub fn revision_id(&self) -> &str {
        &self.proof.candidates[self.candidate].verified.revision_id
    }
    pub fn embedding(&self) -> &[u8] {
        self.proof.candidates[self.candidate]
            .embedding
            .as_deref()
            .unwrap_or(&[])
    }
    pub fn document(&self) -> &ChronicleRetrievalDocument {
        &self.proof.candidates[self.candidate].verified.document
    }
    pub fn evidence_handles(&self) -> &[NirEvidenceHandle] {
        &self.evidence
    }
}

impl NirEvidenceHandle {
    pub fn evidence_id(&self) -> &str {
        &self.proof.candidates[self.candidate].evidence[self.evidence].evidence_id
    }
    pub fn scene_id(&self) -> &str {
        &self.proof.candidates[self.candidate].evidence[self.evidence].scene_id
    }
    pub fn excerpt(&self) -> String {
        let quote = &self.proof.candidates[self.candidate].evidence[self.evidence].quote;
        let mut excerpt = quote.chars().take(180).collect::<String>();
        if quote.chars().count() > 180 {
            excerpt.push('…');
        }
        excerpt
    }
}

// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum NirQualifiedRead {
    Qualified(NirQualifiedBatch),
    Unavailable { reason: Reason },
}

// This transient read result owns its verified snapshot and is consumed
// immediately; keep the payload inline instead of adding a heap allocation.
#[allow(clippy::large_enum_variant)]
pub enum NirQueryStatusRead {
    Available {
        query_context: RetrievalQueryContext,
        index_usable: bool,
        snapshot: Option<NirQuerySnapshot>,
    },
    Unavailable {
        reason: Reason,
    },
}

/// Cheap first-snapshot capability, before capacity admission or scoring.
/// A later usable generation cannot replace this original query snapshot.
pub struct NirQuerySnapshot {
    owner: u64,
    proof: Arc<IndexProof>,
    query: QueryBinding,
}

pub fn validate_chronicle_query_status_snapshot(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &NirQuerySnapshot,
) -> Result<bool> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    validate_chronicle_query_status_snapshot_with_control(conn, runtime, snapshot, &mut control)
}

pub fn validate_chronicle_query_status_snapshot_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &NirQuerySnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    validate_binding_with_control(
        conn,
        runtime,
        snapshot.owner,
        &snapshot.proof,
        &snapshot.query,
        control,
    )
    .map(|query| query.is_some())
}

pub struct NirEvidenceNavigation {
    pub scene_id: String,
    pub quote: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub source_binding: RetrievalSceneSourceBinding,
}

pub enum NirEvidenceNavigationRead {
    Available(NirEvidenceNavigation),
    Unavailable { reason: Reason },
}

pub(super) fn current_proof(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
) -> Result<Option<Arc<IndexProof>>> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    current_proof_with_control(conn, runtime, project, &mut control)
}

pub(super) fn current_proof_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<Option<Arc<IndexProof>>> {
    let proof = runtime.lock()?.proofs.get(project).cloned();
    let Some(proof) = proof else {
        return Ok(None);
    };
    Ok(
        if proof_current_with_control(conn, runtime, &proof, control)? {
            Some(proof)
        } else {
            None
        },
    )
}

pub fn read_chronicle_query_status(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    scene: &str,
) -> Result<NirQueryStatusRead> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    read_chronicle_query_status_with_control(conn, runtime, project, scene, &mut control)
}

pub fn read_chronicle_query_status_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    scene: &str,
    control: &mut dyn GraphWorkControl,
) -> Result<NirQueryStatusRead> {
    let RetrievalQueryContextRead::Available(query_context) =
        read_retrieval_query_context(conn, project, scene)?
    else {
        return Ok(NirQueryStatusRead::Unavailable {
            reason: Reason::QueryUnavailable,
        });
    };
    let snapshot = current_proof_with_control(conn, runtime, project, control)?.map(|proof| {
        NirQuerySnapshot {
            owner: runtime.owner(),
            proof,
            query: QueryBinding::from(&query_context),
        }
    });
    let index_usable = snapshot.is_some();
    Ok(NirQueryStatusRead::Available {
        query_context,
        index_usable,
        snapshot,
    })
}

pub fn qualify_chronicle_index_query(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    project: &str,
    scene: &str,
) -> Result<NirQualifiedRead> {
    let RetrievalQueryContextRead::Available(query) =
        read_retrieval_query_context(conn, project, scene)?
    else {
        return Ok(NirQualifiedRead::Unavailable {
            reason: Reason::QueryUnavailable,
        });
    };
    let Some(proof) = current_proof(conn, runtime, project)? else {
        return Ok(NirQualifiedRead::Unavailable {
            reason: Reason::ColdIndex,
        });
    };
    let mut control = super::super::source_revision::ForegroundValidationControl;
    qualify_proof(runtime, proof, query, &mut control)
}

/// Lend only the exact capability captured before query embedding. One full
/// currentness check covers its immutable proof and original S2 binding.
pub fn qualify_chronicle_index_snapshot(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &NirQuerySnapshot,
) -> Result<NirQualifiedRead> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    qualify_chronicle_index_snapshot_with_control(conn, runtime, snapshot, &mut control)
}

pub fn qualify_chronicle_index_snapshot_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    snapshot: &NirQuerySnapshot,
    control: &mut dyn GraphWorkControl,
) -> Result<NirQualifiedRead> {
    let Some(query) = validate_binding_with_control(
        conn,
        runtime,
        snapshot.owner,
        &snapshot.proof,
        &snapshot.query,
        control,
    )?
    else {
        return Ok(NirQualifiedRead::Unavailable {
            reason: Reason::QueryUnavailable,
        });
    };
    qualify_proof(runtime, snapshot.proof.clone(), query, control)
}

fn qualify_proof(
    runtime: &NirChronicleIndexRuntime,
    proof: Arc<IndexProof>,
    query: RetrievalQueryContext,
    control: &mut dyn GraphWorkControl,
) -> Result<NirQualifiedRead> {
    let binding = QueryBinding::from(&query);
    let mut documents = Vec::new();
    for (index, candidate) in proof.candidates.iter().enumerate() {
        control.check(super::super::nir1_entity_relation_index::GraphWorkStage::Row)?;
        // This gate executes before vectors enter any scorer, ranker or limit.
        if candidate.embedding.is_none() || !candidate.verified.admits(&query) {
            continue;
        }
        let evidence = candidate
            .evidence
            .iter()
            .enumerate()
            .map(|(evidence, _)| NirEvidenceHandle {
                owner: runtime.owner(),
                proof: proof.clone(),
                query: binding.clone(),
                candidate: index,
                evidence,
            })
            .collect();
        documents.push(NirQualifiedDocument {
            proof: proof.clone(),
            candidate: index,
            evidence,
        });
    }
    let state = runtime.lock()?;
    if !state
        .proofs
        .get(&proof.project)
        .is_some_and(|current| Arc::ptr_eq(current, &proof))
        || state.epoch != proof.runtime_epoch
    {
        return Ok(NirQualifiedRead::Unavailable {
            reason: Reason::RuntimeUnavailable,
        });
    }
    drop(state);
    Ok(NirQualifiedRead::Qualified(NirQualifiedBatch {
        owner: runtime.owner(),
        proof,
        query,
        documents,
    }))
}

pub fn validate_chronicle_query_snapshot(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    batch: &NirQualifiedBatch,
) -> Result<bool> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    validate_chronicle_query_snapshot_with_control(conn, runtime, batch, &mut control)
}

pub fn validate_chronicle_query_snapshot_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    batch: &NirQualifiedBatch,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    validate_binding_with_control(
        conn,
        runtime,
        batch.owner,
        &batch.proof,
        &QueryBinding::from(&batch.query),
        control,
    )
    .map(|query| query.is_some())
}

/// Equality of private proof/query identities permits one currentness check;
/// it cannot make a different generation or S2 borrow the original verdict.
pub fn validate_chronicle_bound_batch(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    original: &NirQuerySnapshot,
    batch: &NirQualifiedBatch,
) -> Result<bool> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    validate_chronicle_bound_batch_with_control(conn, runtime, original, batch, &mut control)
}

pub fn validate_chronicle_bound_batch_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    original: &NirQuerySnapshot,
    batch: &NirQualifiedBatch,
    control: &mut dyn GraphWorkControl,
) -> Result<bool> {
    if original.owner != batch.owner
        || !Arc::ptr_eq(&original.proof, &batch.proof)
        || original.query != QueryBinding::from(&batch.query)
    {
        return Ok(false);
    }
    validate_chronicle_query_snapshot_with_control(conn, runtime, batch, control)
}

fn validate_binding_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    owner: u64,
    proof: &Arc<IndexProof>,
    expected: &QueryBinding,
    control: &mut dyn GraphWorkControl,
) -> Result<Option<RetrievalQueryContext>> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 result validation requires a read transaction"
    );
    if owner != runtime.owner() {
        return Ok(None);
    }
    let current = runtime.lock()?.proofs.get(&proof.project).cloned();
    if current.is_none_or(|current| !Arc::ptr_eq(&current, proof))
        || !proof_current_with_control(conn, runtime, proof, control)?
    {
        return Ok(None);
    }
    let RetrievalQueryContextRead::Available(query) =
        read_retrieval_query_context(conn, &expected.project, &expected.scene)?
    else {
        return Ok(None);
    };
    Ok(
        if QueryBinding::from(&query) == *expected
            && runtime.current_epoch(conn)? == Ok(proof.runtime_epoch)
        {
            Some(query)
        } else {
            None
        },
    )
}

pub fn read_chronicle_evidence_navigation(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    handle: &NirEvidenceHandle,
) -> Result<NirEvidenceNavigationRead> {
    let mut control = super::super::source_revision::ForegroundValidationControl;
    read_chronicle_evidence_navigation_with_control(conn, runtime, handle, &mut control)
}

pub fn read_chronicle_evidence_navigation_with_control(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    handle: &NirEvidenceHandle,
    control: &mut dyn GraphWorkControl,
) -> Result<NirEvidenceNavigationRead> {
    let unavailable = || NirEvidenceNavigationRead::Unavailable {
        reason: Reason::EvidenceUnavailable,
    };
    let Some(query) = validate_binding_with_control(
        conn,
        runtime,
        handle.owner,
        &handle.proof,
        &handle.query,
        control,
    )?
    else {
        return Ok(unavailable());
    };
    let candidate = &handle.proof.candidates[handle.candidate];
    if !candidate.verified.admits(&query) {
        return Ok(unavailable());
    }
    let evidence = &candidate.evidence[handle.evidence];
    let RetrievalSceneSourceRead::Available(source) =
        read_retrieval_scene_source(conn, &handle.proof.project, &evidence.scene_id)?
    else {
        return Ok(unavailable());
    };
    if source.archived
        || source.query_source != evidence.source
        || !exact_utf16_quote(
            &source.canonical_source_text,
            &evidence.quote,
            evidence.start_utf16,
            evidence.end_utf16,
        )
        || runtime.current_epoch(conn)? != Ok(handle.proof.runtime_epoch)
    {
        return Ok(unavailable());
    }
    Ok(NirEvidenceNavigationRead::Available(
        NirEvidenceNavigation {
            scene_id: evidence.scene_id.clone(),
            quote: evidence.quote.clone(),
            start_utf16: evidence.start_utf16,
            end_utf16: evidence.end_utf16,
            source_binding: source.query_source,
        },
    ))
}

/// Reconciliation drops unusable proofs and returns projects for synchronous
/// operation/UI invalidation before a background worker starts rebuilding.
pub fn reconcile_chronicle_index_runtime(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
) -> Result<Vec<String>> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 reconciliation requires a read transaction"
    );
    let proofs = runtime.lock()?.proofs.values().cloned().collect::<Vec<_>>();
    let mut changed = Vec::new();
    for proof in proofs {
        if proof_current(conn, runtime, &proof)? {
            continue;
        }
        let mut state = runtime.lock()?;
        if state
            .proofs
            .get(&proof.project)
            .is_some_and(|current| Arc::ptr_eq(current, &proof))
        {
            state.proofs.remove(&proof.project);
            changed.push(proof.project.clone());
        }
    }
    changed.sort();
    Ok(changed)
}
