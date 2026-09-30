use std::collections::HashSet;

use anyhow::{ensure, Result};
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{build::BuildSnapshot, NirEmbeddedDocument, NirEmbeddingIdentity};
use crate::ai_audit::{ai_audit_scope_id, verify_ai_audit_chain_for_scope};

pub(super) fn verify_outcomes(
    conn: &Connection,
    project: &str,
    snapshot: &BuildSnapshot,
    outcomes: &[NirEmbeddedDocument],
) -> Result<()> {
    ensure!(
        outcomes.len() == snapshot.candidates.len(),
        "NIR1 incomplete embedding outcomes"
    );
    if outcomes.is_empty() {
        return Ok(());
    }
    ensure!(
        verify_ai_audit_chain_for_scope(conn, Some(project), None)?.ok,
        "NIR1 embedding audit chain invalid"
    );
    let expected = snapshot
        .candidates
        .iter()
        .map(|c| (&c.revision_id, &c.document))
        .collect::<std::collections::HashMap<_, _>>();
    let mut seen = HashSet::new();
    let mut executions = HashSet::new();
    let mut model: Option<&NirEmbeddingIdentity> = None;
    for outcome in outcomes {
        let document = outcome.document();
        ensure!(
            seen.insert(&document.revision_id)
                && expected.get(&document.revision_id) == Some(&document),
            "NIR1 embedding document binding mismatch"
        );
        let identity = outcome.identity();
        if let Some(previous) = model {
            ensure!(previous == identity, "NIR1 mixed model identities");
        }
        model = Some(identity);
        ensure!(
            identity.embedding_dim > 0
                && !identity.model_id.trim().is_empty()
                && !identity.chunker_version.trim().is_empty()
                && is_hex_digest(&identity.artifact_sha256)
                && is_hex_digest(&identity.tokenizer_sha256),
            "NIR1 embedding model identity invalid"
        );
        ensure!(
            executions.insert(&outcome.audit_binding().execution_id),
            "NIR1 reused embedding audit execution"
        );
        verify_execution(conn, project, outcome)?;
    }
    Ok(())
}

fn verify_execution(conn: &Connection, project: &str, outcome: &NirEmbeddedDocument) -> Result<()> {
    let binding = outcome.audit_binding();
    ensure!(
        !binding.operation_id.trim().is_empty() && !binding.execution_id.trim().is_empty(),
        "NIR1 audit binding missing"
    );
    let scope = ai_audit_scope_id(Some(project))?;
    let mut statement = conn.prepare(
        "SELECT project_id,operation_id,path_id,event_type,payload
        FROM ai_audit_events WHERE scope_id=?1 AND execution_id=?2 ORDER BY sequence LIMIT 6",
    )?;
    let rows = statement
        .query_map(params![scope, binding.execution_id], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let kinds: &[&str] = match outcome {
        NirEmbeddedDocument::Indexed { .. } => &[
            "execution.started",
            "request.prepared",
            "request.dispatched",
            "response.completed",
            "execution.succeeded",
        ],
        NirEmbeddedDocument::SkippedTokenLimit { .. } => {
            &["execution.started", "request.prepared", "execution.skipped"]
        }
    };
    ensure!(
        rows.len() == kinds.len(),
        "NIR1 audit execution incomplete or unexpected"
    );
    let doc = outcome.document();
    let mut payloads = Vec::with_capacity(rows.len());
    for ((row_project, operation, path, kind, raw), expected_kind) in rows.into_iter().zip(kinds) {
        ensure!(
            row_project.as_deref() == Some(project)
                && operation == binding.operation_id
                && path == "semantic_embedding_index"
                && kind == *expected_kind,
            "NIR1 audit execution identity mismatch"
        );
        let payload: Value = serde_json::from_str(&raw)?;
        let metadata = &payload["metadata"];
        ensure!(
            payload["inferenceKind"] == "embedding.document"
                && metadata["domain"] == "nir1-chronicle-revision"
                && metadata["revisionId"] == doc.revision_id
                && metadata["envelopeDigest"] == doc.envelope_digest
                && metadata["serializerRef"] == doc.serializer_ref
                && metadata["serializedStatementDigest"] == doc.serialized_statement_digest
                && metadata["truncationPolicy"] == "reject-complete-input-over-model-token-limit",
            "NIR1 audit input identity mismatch"
        );
        payloads.push(payload);
    }
    ensure!(
        payloads[0]["modelDispatched"] == false && payloads[0]["executionMode"] == "local-native",
        "NIR1 audit start invalid"
    );
    let prepared = &payloads[1];
    let identity = outcome.identity();
    let model = &prepared["model"];
    ensure!(
        prepared["credentialsExcluded"] == true
            && model["engine"] == "onnx-runtime"
            && model["executionProvider"] == "cpu"
            && model["modelId"] == identity.model_id
            && model["artifactSha256"] == identity.artifact_sha256
            && model["artifactIdentity"]["sha256"] == identity.artifact_sha256
            && model["tokenizerIdentity"]["sha256"] == identity.tokenizer_sha256
            && model["embeddingDim"].as_u64() == Some(identity.embedding_dim as u64)
            && model["chunkerVersion"] == identity.chunker_version,
        "NIR1 audit effective model mismatch"
    );
    let input = &prepared["input"];
    let prefix = input["modelPrefix"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("NIR1 audit model prefix missing"))?;
    let model_text = format!("{prefix}{}", doc.serialized_statement);
    ensure!(
        input["rawText"] == doc.serialized_statement
            && input["rawTextSha256"] == sha(&doc.serialized_statement)
            && input["rawTextByteLength"].as_u64() == Some(doc.serialized_statement.len() as u64)
            && input["rawTextCharLength"].as_u64()
                == Some(doc.serialized_statement.chars().count() as u64)
            && input["modelText"] == model_text
            && input["modelTextSha256"] == sha(&model_text)
            && input["modelTextByteLength"].as_u64() == Some(model_text.len() as u64)
            && input["tokenizerAddsSpecialTokens"] == true
            && input.get("tokenizerMayTruncateAt") == Some(&Value::Null),
        "NIR1 audit complete input mismatch"
    );
    match outcome {
        NirEmbeddedDocument::Indexed { embedding, .. } => {
            ensure!(
                embedding.len()
                    == identity
                        .embedding_dim
                        .checked_mul(4)
                        .ok_or_else(|| anyhow::anyhow!("NIR1 dimension overflow"))?,
                "NIR1 vector dimension mismatch"
            );
            let mut norm = 0.0_f64;
            for chunk in embedding.as_chunks::<4>().0 {
                let value = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                ensure!(value.is_finite(), "NIR1 non-finite vector");
                norm += f64::from(value).powi(2);
            }
            ensure!(norm > 0.0 && norm.is_finite(), "NIR1 invalid vector norm");
            ensure!(
                payloads[2]["completeInputPreflightPassed"] == true
                    && payloads[2]["dispatchBoundary"] == "immediately-before-onnx-inference"
                    && payloads[3]["embeddingSha256"] == sha(embedding)
                    && payloads[3]["embeddingDim"].as_u64() == Some(identity.embedding_dim as u64)
                    && payloads[3]["rawEmbeddingOmitted"] == true
                    && payloads[4]["modelDispatched"] == true
                    && payloads[4]["localPipelineCompleted"] == true
                    && payloads[4]["onnxResultObserved"] == true,
                "NIR1 audit inference outcome mismatch"
            );
        }
        NirEmbeddedDocument::SkippedTokenLimit {
            actual_tokens,
            maximum_tokens,
            ..
        } => {
            ensure!(
                *maximum_tokens > 0
                    && actual_tokens > maximum_tokens
                    && model["maxSequenceTokens"].as_u64() == Some(*maximum_tokens as u64)
                    && payloads[2]["reason"] == "document-token-limit"
                    && payloads[2]["phase"] == "before-onnx"
                    && payloads[2]["details"]["actualTokens"].as_u64()
                        == Some(*actual_tokens as u64)
                    && payloads[2]["details"]["maximumTokens"].as_u64()
                        == Some(*maximum_tokens as u64)
                    && payloads[2]["modelDispatched"] == false
                    && payloads[2]["onnxSessionRunObserved"] == false,
                "NIR1 audit token-limit outcome mismatch"
            );
        }
    }
    Ok(())
}

fn is_hex_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha(value: impl AsRef<[u8]>) -> String {
    hex::encode(Sha256::digest(value.as_ref()))
}
