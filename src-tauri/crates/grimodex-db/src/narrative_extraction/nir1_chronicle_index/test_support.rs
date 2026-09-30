//! Private deterministic storage/audit contract fixtures. These vectors are
//! deliberately synthetic and are never retrieval-quality or model evidence.
use std::{io::Read, path::PathBuf};

use flate2::read::GzDecoder;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{super::retrieval_admission::ChronicleRetrievalDocument, *};
use crate::{ai_audit::AppendAiAuditEvent, Database};

pub(super) struct Fixture {
    pub db: Database,
    pub runtime: NirChronicleIndexRuntime,
    pub manifest: Value,
    path: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        let mut bytes = Vec::new();
        GzDecoder::new(
            include_bytes!("../../../tests/support/nir1-reviewed-child-cold.db.gz").as_slice(),
        )
        .read_to_end(&mut bytes)
        .expect("normal UI cold workspace");
        let path = std::env::temp_dir().join(format!("nir1-index-{}.db", uuid::Uuid::new_v4()));
        std::fs::write(&path, bytes).expect("private workspace");
        let db = Database::new(&path).expect("fixture connection");
        db.migrate().expect("schema upgrade");
        let runtime = NirChronicleIndexRuntime::new(&db, 1);
        let manifest = serde_json::from_str(include_str!(
            "../../../tests/support/nir1-reviewed-child-cold.json"
        ))
        .expect("provenance");
        Self {
            db,
            runtime,
            manifest,
            path,
        }
    }

    pub fn project(&self) -> &str {
        self.manifest["projectId"].as_str().expect("project")
    }

    pub fn prepare(&self) -> (NirIndexBuildPlan, Vec<ChronicleRetrievalDocument>) {
        self.db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                match prepare_chronicle_index_build(&tx, &self.runtime, self.project())? {
                    NirIndexBuildRead::Ready { plan, documents } => Ok((plan, documents)),
                    NirIndexBuildRead::Unavailable { reason } => {
                        anyhow::bail!("unexpected preparation {reason:?}")
                    }
                    NirIndexBuildRead::AlreadyUsable => anyhow::bail!("unexpected reusable proof"),
                }
            })
            .expect("prepare full current pool")
    }

    pub fn outcomes(&self, docs: Vec<ChronicleRetrievalDocument>) -> Vec<NirEmbeddedDocument> {
        docs.into_iter()
            .map(|doc| self.outcome(doc, false))
            .collect()
    }

    pub fn outcome(&self, document: ChronicleRetrievalDocument, skip: bool) -> NirEmbeddedDocument {
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
        self.db
            .append_ai_audit_events(self.project(), &events)
            .expect("normal durable audit append");
        let audit_binding = NirEmbeddingAuditBinding {
            operation_id,
            execution_id,
        };
        if skip {
            NirEmbeddedDocument::SkippedTokenLimit {
                document,
                identity,
                audit_binding,
                actual_tokens: 513,
                maximum_tokens: 512,
            }
        } else {
            NirEmbeddedDocument::Indexed {
                document,
                embedding,
                identity,
                audit_binding,
            }
        }
    }

    pub fn published_count(&self) -> i64 {
        self.db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM narrative_nir1_chronicle_vectors WHERE project_id=?1",
                    [self.project()],
                    |r| r.get(0),
                )?)
            })
            .expect("derived row count")
    }

    pub fn hold(&self, revision: &str) {
        use crate::narrative_extraction::{
            narrative_extraction_append_human_decision, AppendDecisionPayload,
        };
        let proposal = self
            .db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT proposal_id FROM narrative_proposal_revisions WHERE id=?1",
                    [revision],
                    |r| r.get::<_, String>(0),
                )?)
            })
            .expect("current proposal");
        narrative_extraction_append_human_decision(
            &self.db,
            AppendDecisionPayload {
                run_id: self.manifest["runId"]
                    .as_str()
                    .expect("original run")
                    .into(),
                project_id: self.project().into(),
                proposal_id: proposal,
                revision_id: revision.into(),
                decision: "held".into(),
                decision_json: Some(json!({"probableDuplicateChoice":"hold"})),
                created_by: None,
            },
        )
        .expect("Native Human withdrawal");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Deterministic interruption inside a requested stage, after work has begun.
pub(super) struct StopAt(pub super::super::GraphWorkStage);

impl super::super::GraphWorkControl for StopAt {
    fn check(&mut self, stage: super::super::GraphWorkStage) -> anyhow::Result<()> {
        if stage == self.0 {
            return Err(super::super::validation_terminated(
                super::super::ValidationTerminationReason::Cancelled,
                "test Chronicle owner stopped",
            ));
        }
        Ok(())
    }

    fn allows_full_eligibility(&self) -> bool {
        true
    }
}

pub(super) fn assert_stopped<T>(result: anyhow::Result<T>) {
    let error = result.err().expect("controlled work must observe stop");
    assert_eq!(
        error
            .downcast_ref::<super::super::ValidationTerminated>()
            .map(|error| error.reason),
        Some(super::super::ValidationTerminationReason::Cancelled),
        "stop must not become unavailable, stale, or Source missing: {error:#}"
    );
}
