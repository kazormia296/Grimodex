use std::collections::HashMap;

use anyhow::{ensure, Result};
use chrono::{SecondsFormat, Utc};
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use rusqlite::{params, Connection};

use super::super::{
    declaration_storage::{
        write_dependency_declaration_set_in_tx, DependencyDeclaration,
        DependencyDeclarationSetRequest,
    },
    dependency_edges::{
        delete_edges_for_consumer_in_tx, find_edges_by_consumer, record_dependency_edge_in_tx,
    },
    evaluator::{BuildAction, EvidenceFreshness},
    publish_runtime::publish_complete_runless_freshness_in_tx,
    restore_rebuild::evaluate_owned_edges_from_db_in_tx,
    task_leases::with_immediate_transaction,
};
use super::{
    audit::verify_outcomes,
    binding::{self, BindingRead},
    build::{self, BuildSnapshot, NirIndexBuildPlan},
    runtime::{IndexProof, IndexedCandidate},
    NirChronicleIndexRuntime, NirEmbeddedDocument, NirIndexPublishRead, INDEX_KEY, PRODUCER_ID,
    PRODUCER_VERSION,
};
use crate::Database;

pub fn publish_chronicle_index_build(
    db: &Database,
    runtime: &NirChronicleIndexRuntime,
    plan: NirIndexBuildPlan,
    outcomes: Vec<NirEmbeddedDocument>,
) -> Result<NirIndexPublishRead> {
    if plan.owner != runtime.owner() {
        return Ok(NirIndexPublishRead::Stale);
    }
    let runtime_epoch = plan.runtime_epoch;
    let proof = db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            if runtime.current_epoch(conn)? != Ok(plan.runtime_epoch) {
                return Ok(None);
            }
            if !build::snapshot_current(conn, &plan.project, &plan.snapshot)? {
                return Ok(None);
            }
            verify_outcomes(conn, &plan.project, &plan.snapshot, &outcomes)?;
            publish_chronicle_index_build_in_tx(
                conn,
                &plan.project,
                plan.runtime_epoch,
                plan.snapshot,
                outcomes,
            )
            .map(Some)
        })
    })?;
    let Some(proof) = proof else {
        return Ok(NirIndexPublishRead::Stale);
    };
    let generation = proof.binding.generation;
    let candidate_count = proof
        .candidates
        .iter()
        .filter(|candidate| candidate.embedding.is_some())
        .count();
    // Stop/pause during inference or the commit window may leave valid cache
    // rows, but cannot install a live proof or emit a ready notification.
    let newly_usable_published = runtime.install(runtime_epoch, proof)?;
    Ok(NirIndexPublishRead::Published {
        generation,
        candidate_count,
        newly_usable_published,
    })
}

// NARRATIVE_DEPENDENCY_PRODUCER: nir1-reviewed-chronicle-v1
pub(super) fn publish_chronicle_index_build_in_tx(
    conn: &Connection,
    project: &str,
    runtime_epoch: u64,
    snapshot: BuildSnapshot,
    outcomes: Vec<NirEmbeddedDocument>,
) -> Result<IndexProof> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 publication requires a write transaction"
    );
    let generation = snapshot
        .prior
        .as_ref()
        .map_or(0, |prior| prior.generation)
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("NIR1 index generation exhausted"))?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let declarations = snapshot
        .edges
        .iter()
        .map(|edge| DependencyDeclaration {
            source_object_identity: edge.source_object_identity.clone(),
            role: DependencyRole::RankingOnly,
            selector: DependencySelector::WholeSource,
        })
        .collect();
    let d1 = write_dependency_declaration_set_in_tx(
        conn,
        DependencyDeclarationSetRequest {
            project_id: project.into(),
            consumer_kind: "semantic-index".into(),
            consumer_key: INDEX_KEY.into(),
            producer_id: PRODUCER_ID.into(),
            producer_generation: generation,
            expected_head_version: snapshot
                .prior
                .as_ref()
                .map_or(0, |prior| prior.head_version),
            declarations,
            created_at: now.clone(),
        },
    )?;
    delete_edges_for_consumer_in_tx(conn, project, "semantic-index", INDEX_KEY)?;
    for edge in &snapshot.edges {
        record_dependency_edge_in_tx(
            conn,
            project,
            "semantic-index",
            INDEX_KEY,
            &edge.source_object_identity,
            &edge.read_set_json,
            None,
            edge.owning_run_id.as_deref(),
            &now,
        )?;
    }
    conn.execute("INSERT INTO narrative_semantic_index_metadata
        (project_id,index_key,generation,built_at,source_digest,dependency_set_digest,dirty_cache_flag,producer_id,producer_version)
        VALUES (?1,?2,?3,?4,?5,?6,0,?7,?8) ON CONFLICT(project_id,index_key) DO UPDATE SET
        generation=excluded.generation,built_at=excluded.built_at,source_digest=excluded.source_digest,
        dependency_set_digest=excluded.dependency_set_digest,dirty_cache_flag=0,producer_id=excluded.producer_id,producer_version=excluded.producer_version",
        params![project,INDEX_KEY,generation,now,snapshot.roster_digest,d1.dependency_set_digest,PRODUCER_ID,PRODUCER_VERSION])?;
    let input_edges = find_edges_by_consumer(conn, project, "semantic-index", INDEX_KEY)?;
    let observations = input_edges
        .iter()
        .zip(evaluate_owned_edges_from_db_in_tx(
            conn,
            project,
            &input_edges,
        )?)
        .map(|(edge, observation)| {
            ensure!(
                observation.freshness == EvidenceFreshness::Fresh
                    && observation.build_action == BuildAction::None
                    && observation.reason_code.is_none(),
                "NIR1 publication Source is not current"
            );
            Ok((edge.id.clone(), observation))
        })
        .collect::<Result<Vec<_>>>()?;
    publish_complete_runless_freshness_in_tx(
        conn,
        project,
        "semantic-index",
        INDEX_KEY,
        &observations,
        &snapshot.semantic_epoch,
        &now,
    )?;
    conn.execute(
        "DELETE FROM narrative_nir1_chronicle_vectors WHERE project_id=?1",
        [project],
    )?;
    let model = outcomes.first().map(|outcome| outcome.identity().clone());
    let mut outcomes = outcomes
        .into_iter()
        .map(|outcome| (outcome.document().revision_id.clone(), outcome))
        .collect::<HashMap<_, _>>();
    let mut candidates = Vec::with_capacity(snapshot.candidates.len());
    for candidate in snapshot.candidates {
        let outcome = outcomes
            .remove(&candidate.revision_id)
            .ok_or_else(|| anyhow::anyhow!("NIR1 planned outcome missing"))?;
        let embedding = match outcome {
            NirEmbeddedDocument::Indexed {
                document,
                embedding,
                identity,
                audit_binding,
            } => {
                conn.execute("INSERT INTO narrative_nir1_chronicle_vectors
                    (project_id,revision_id,generation,envelope_digest,statement_digest,serializer_ref,model_id,artifact_sha256,
                     tokenizer_sha256,embedding_dim,chunker_version,audit_operation_id,audit_execution_id,embedding)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                    params![project,document.revision_id,generation,document.envelope_digest,document.serialized_statement_digest,
                        document.serializer_ref,identity.model_id,identity.artifact_sha256,identity.tokenizer_sha256,
                        i64::try_from(identity.embedding_dim)?,identity.chunker_version,audit_binding.operation_id,audit_binding.execution_id,embedding])?;
                Some(embedding)
            }
            NirEmbeddedDocument::SkippedTokenLimit { .. } => None,
        };
        let evidence = super::evidence::read_verified_evidence(conn, project, &candidate)?;
        ensure!(
            !evidence.is_empty(),
            "NIR1 admitted revision has no valid Evidence navigation"
        );
        candidates.push(IndexedCandidate {
            verified: candidate,
            embedding,
            evidence,
        });
    }
    let BindingRead::Registered(binding) = binding::read(conn, project)? else {
        anyhow::bail!("NIR1 published binding is incoherent");
    };
    Ok(IndexProof {
        validated_read: std::sync::Mutex::new(None),
        project: project.into(),
        runtime_epoch,
        binding,
        semantic_epoch: snapshot.semantic_epoch,
        language: snapshot.language,
        candidates,
        model,
        input_edges,
    })
}
