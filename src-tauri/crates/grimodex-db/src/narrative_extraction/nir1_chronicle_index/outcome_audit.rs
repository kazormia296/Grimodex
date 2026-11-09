use super::super::retrieval_admission::ChronicleRetrievalDocument;
use super::*;
use crate::ai_audit::AppendAiAuditEvent;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

type OutcomeAudit = (
    Vec<AppendAiAuditEvent>,
    String,
    String,
    NirEmbeddingIdentity,
    Vec<u8>,
);

/// The five-event embedding audit of `document` (`skip`: the token-limit
/// shape), with the bindings it names. Synthetic storage-contract data.
pub(super) fn outcome_audit(document: &ChronicleRetrievalDocument, skip: bool) -> OutcomeAudit {
    let execution_id = uuid::Uuid::new_v4().to_string();
    let operation_id = uuid::Uuid::new_v4().to_string();
    let identity = NirEmbeddingIdentity {
        model_id: "test-only-storage-contract".into(),
        artifact_sha256: "a".repeat(64),
        tokenizer_sha256: "b".repeat(64),
        embedding_dim: 2,
        chunker_version: "test-only-no-chunking".into(),
    };
    let embedding = [1.0_f32, 0.0]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect::<Vec<_>>();
    let metadata = json!({"domain":"nir1-chronicle-revision","revisionId":document.revision_id,
            "envelopeDigest":document.envelope_digest,"serializerRef":document.serializer_ref,
            "serializedStatementDigest":document.serialized_statement_digest,
            "truncationPolicy":"reject-complete-input-over-model-token-limit"});
    let event = |kind: &str, mut body: Value| {
        body["captureState"] = json!("complete");
        body["inferenceKind"] = json!("embedding.document");
        body["metadata"] = metadata.clone();
        AppendAiAuditEvent {
            event_id: uuid::Uuid::new_v4().to_string(),
            execution_id: execution_id.clone(),
            operation_id: operation_id.clone(),
            parent_execution_id: None,
            path_id: "semantic_embedding_index".into(),
            event_type: kind.into(),
            timestamp: chrono::Utc::now().timestamp_millis(),
            payload: body,
        }
    };
    let sha = |bytes: &[u8]| hex::encode(Sha256::digest(bytes));
    let model_text = format!("test-prefix:{}", document.serialized_statement);
    let mut events = vec![
        event(
            "execution.started",
            json!({"modelDispatched":false,"executionMode":"local-native"}),
        ),
        event(
            "request.prepared",
            json!({"credentialsExcluded":true,"model":{
                "engine":"onnx-runtime","executionProvider":"cpu","modelId":identity.model_id,
                "artifactSha256":identity.artifact_sha256,"artifactIdentity":{"sha256":identity.artifact_sha256},
                "tokenizerIdentity":{"sha256":identity.tokenizer_sha256},"embeddingDim":2,"chunkerVersion":identity.chunker_version,"maxSequenceTokens":512},
                "input":{"rawText":document.serialized_statement,"rawTextSha256":sha(document.serialized_statement.as_bytes()),
                    "rawTextByteLength":document.serialized_statement.len(),"rawTextCharLength":document.serialized_statement.chars().count(),
                    "modelPrefix":"test-prefix:","modelText":model_text,"modelTextSha256":sha(model_text.as_bytes()),
                    "modelTextByteLength":model_text.len(),"tokenizerAddsSpecialTokens":true,"tokenizerMayTruncateAt":null}}),
        ),
    ];
    if skip {
        events.push(event("execution.skipped",json!({"reason":"document-token-limit","phase":"before-onnx",
                "modelDispatched":false,"onnxSessionRunObserved":false,"details":{"actualTokens":513,"maximumTokens":512}})));
    } else {
        events.extend([
                event("request.dispatched",json!({"completeInputPreflightPassed":true,"dispatchBoundary":"immediately-before-onnx-inference"})),
                event("response.completed",json!({"embeddingSha256":sha(&embedding),"embeddingDim":2,"rawEmbeddingOmitted":true})),
                event("execution.succeeded",json!({"modelDispatched":true,"localPipelineCompleted":true,"onnxResultObserved":true})),
            ]);
    }
    (events, execution_id, operation_id, identity, embedding)
}

/// Cross-crate test support (`workspace-maintenance-test-support`): append the
/// synthetic embedding audit of every document through the normal durable
/// append and return the matching `Indexed` outcomes, so a test can publish a
/// real Chronicle index without an embedder.
#[doc(hidden)]
pub fn synthetic_embedded_outcomes_for_test(
    db: &crate::Database,
    project: &str,
    documents: Vec<ChronicleRetrievalDocument>,
) -> anyhow::Result<Vec<NirEmbeddedDocument>> {
    documents
        .into_iter()
        .map(|document| {
            let (events, execution_id, operation_id, identity, embedding) =
                outcome_audit(&document, false);
            db.append_ai_audit_events(project, &events)?;
            Ok(NirEmbeddedDocument::Indexed {
                document,
                embedding,
                identity,
                audit_binding: NirEmbeddingAuditBinding {
                    operation_id,
                    execution_id,
                },
            })
        })
        .collect()
}
