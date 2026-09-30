use anyhow::{ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};

use super::{
    binding::{self, BindingRead},
    NirChronicleIndexRuntime, NirEmbeddedDocument, NirEmbeddingAuditBinding, NirEmbeddingIdentity,
    NirIndexBuildPlan,
};

/// Reuse is only an embedding optimization after complete cold admission.
/// These values grant no query capability: publication still revalidates the
/// current build and every original audit execution, including vector hashes.
pub fn read_reusable_chronicle_embeddings(
    conn: &Connection,
    runtime: &NirChronicleIndexRuntime,
    plan: &NirIndexBuildPlan,
    identity: &NirEmbeddingIdentity,
) -> Result<Vec<NirEmbeddedDocument>> {
    ensure!(
        !conn.is_autocommit(),
        "NIR1 cache read requires a read transaction"
    );
    if plan.owner != runtime.owner() || runtime.current_epoch(conn)? != Ok(plan.runtime_epoch) {
        return Ok(Vec::new());
    }
    let Some(prior) = &plan.snapshot.prior else {
        return Ok(Vec::new());
    };
    if binding::read(conn, &plan.project)? != BindingRead::Registered(prior.clone()) {
        return Ok(Vec::new());
    }
    let mut statement = conn.prepare(
        "SELECT embedding,audit_operation_id,audit_execution_id
        FROM narrative_nir1_chronicle_vectors WHERE project_id=?1 AND revision_id=?2
        AND generation=?3 AND envelope_digest=?4 AND statement_digest=?5 AND serializer_ref=?6
        AND model_id=?7 AND artifact_sha256=?8 AND tokenizer_sha256=?9
        AND embedding_dim=?10 AND chunker_version=?11",
    )?;
    let mut outcomes = Vec::new();
    for candidate in &plan.snapshot.candidates {
        let doc = &candidate.document;
        let cached = statement
            .query_row(
                params![
                    plan.project,
                    doc.revision_id,
                    prior.generation,
                    doc.envelope_digest,
                    doc.serialized_statement_digest,
                    doc.serializer_ref,
                    identity.model_id,
                    identity.artifact_sha256,
                    identity.tokenizer_sha256,
                    i64::try_from(identity.embedding_dim)?,
                    identity.chunker_version
                ],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?;
        if let Some((embedding, operation_id, execution_id)) = cached {
            outcomes.push(NirEmbeddedDocument::Indexed {
                document: doc.clone(),
                embedding,
                identity: identity.clone(),
                audit_binding: NirEmbeddingAuditBinding {
                    operation_id,
                    execution_id,
                },
            });
        }
    }
    Ok(outcomes)
}
