use super::audited_query::strict_project_spec;
use super::*;
use crate::audit::{
    embedding_output_payload, sha256_hex, ModelArtifactIdentity, TokenizerIdentity,
};
use crate::embedding::{CompleteDocumentEncoding, DocumentTokenLimit};

const NIR1_SERIALIZER_REF: &str = "chronicle-semantic-retrieval/1";
const NIR1_FIELDS: [&str; 4] = ["summary", "actuality", "attribution", "narrativeFrame"];

/// Native-only input supplied by the canonical DB build adapter. It deliberately
/// contains no mutable event fields, full envelope or context roster.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Nir1EmbeddingDocument {
    pub revision_id: String,
    pub envelope_digest: String,
    pub serializer_ref: String,
    pub serialized_statement: String,
    pub serialized_statement_digest: String,
}

/// Native-only output. The DB writer must revalidate its complete current
/// revision/material/Index CAS before persisting any returned vector.
pub enum Nir1DocumentEmbeddingOutcome {
    Indexed {
        document: Nir1EmbeddingDocument,
        embedding: Vec<u8>,
        identity: SemanticEmbeddingIdentity,
        audit_binding: SemanticEmbeddingAuditBinding,
    },
    SkippedTokenLimit {
        document: Nir1EmbeddingDocument,
        limit: DocumentTokenLimit,
        identity: SemanticEmbeddingIdentity,
        audit_binding: SemanticEmbeddingAuditBinding,
    },
}

pub(super) trait Nir1DocumentPipeline {
    type Prepared;
    fn prepare(&mut self, text: &str) -> Result<Self::Prepared>;
    fn embed(&mut self, prepared: Self::Prepared) -> Result<Vec<f32>>;
}

impl Nir1DocumentPipeline for Embedder {
    type Prepared = CompleteDocumentEncoding;
    fn prepare(&mut self, text: &str) -> Result<Self::Prepared> {
        self.prepare_document_untruncated(text)
    }
    fn embed(&mut self, prepared: Self::Prepared) -> Result<Vec<f32>> {
        self.embed_prepared_document(prepared)
    }
}

fn validate_document(document: &Nir1EmbeddingDocument) -> Result<()> {
    anyhow::ensure!(
        !document.revision_id.is_empty()
            && document.serializer_ref == NIR1_SERIALIZER_REF
            && document.envelope_digest.len() == 71
            && document.envelope_digest.starts_with("sha256:")
            && document.envelope_digest[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "NIR1_DOCUMENT_BINDING_INVALID"
    );
    let expected = format!(
        "sha256:{}",
        sha256_hex(document.serialized_statement.as_bytes())
    );
    anyhow::ensure!(
        document.serialized_statement_digest == expected,
        "NIR1_DOCUMENT_DIGEST_MISMATCH"
    );
    let value: serde_json::Value = serde_json::from_str(&document.serialized_statement)
        .map_err(|_| anyhow!("NIR1_DOCUMENT_SERIALIZATION_INVALID"))?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("NIR1_DOCUMENT_SERIALIZATION_INVALID"))?;
    anyhow::ensure!(
        object.len() == NIR1_FIELDS.len()
            && object.keys().map(String::as_str).eq(NIR1_FIELDS)
            && object.values().all(serde_json::Value::is_string)
            && serde_json::to_string(&value)? == document.serialized_statement,
        "NIR1_DOCUMENT_SERIALIZATION_INVALID"
    );
    Ok(())
}

fn validate_current(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    project_id: &str,
    identity: &SemanticEmbeddingIdentity,
) -> Result<()> {
    let current = runtime.snapshot_epoch();
    anyhow::ensure!(
        current.generation == request.epoch.generation
            && Arc::ptr_eq(&current.caches, &request.epoch.caches),
        "SEMANTIC_QUERY_STALE"
    );
    anyhow::ensure!(
        identity.matches_spec(strict_project_spec(request, project_id)?),
        "SEMANTIC_QUERY_MODEL_CHANGED"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) fn embed_document_with<P: Nir1DocumentPipeline>(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    project_id: &str,
    document: &Nir1EmbeddingDocument,
    spec: &'static EmbeddingModelSpec,
    model: ModelArtifactIdentity,
    tokenizer: TokenizerIdentity,
    pipeline: &mut P,
) -> Result<Nir1DocumentEmbeddingOutcome> {
    validate_document(document)?;
    let identity = SemanticEmbeddingIdentity::from_loaded(spec, &model, &tokenizer);
    validate_current(runtime, request, project_id, &identity)?;
    let mut audit = start_embedding_audit(
        request,
        project_id,
        AuditedEmbeddingInput {
            path_id: "semantic_embedding_index",
            inference_kind: "embedding.document",
            spec,
            model_artifact_identity: model,
            tokenizer_identity: tokenizer,
            raw_text: &document.serialized_statement,
            model_prefix: spec.document_prefix,
            metadata: json!({
                "domain": "nir1-chronicle-revision", "revisionId": document.revision_id,
                "envelopeDigest": document.envelope_digest, "serializerRef": document.serializer_ref,
                "serializedStatementDigest": document.serialized_statement_digest,
                "truncationPolicy": "reject-complete-input-over-model-token-limit",
            }),
        },
        false,
        true,
    )?;
    let audit_binding = SemanticEmbeddingAuditBinding {
        operation_id: request.operation_id().into(),
        execution_id: audit.execution_id().into(),
    };
    let prepared =
        match pipeline.prepare(&document.serialized_statement) {
            Ok(prepared) => prepared,
            Err(error) => {
                if let Some(limit) = error.downcast_ref::<DocumentTokenLimit>().copied() {
                    audit.skip_before_onnx("document-token-limit", json!({
                    "actualTokens": limit.actual_tokens, "maximumTokens": limit.maximum_tokens,
                }))?;
                    validate_current(runtime, request, project_id, &identity)?;
                    return Ok(Nir1DocumentEmbeddingOutcome::SkippedTokenLimit {
                        document: document.clone(),
                        limit,
                        identity,
                        audit_binding,
                    });
                }
                return audit.fail_preparation(error);
            }
        };
    if let Err(error) = validate_current(runtime, request, project_id, &identity) {
        return audit.fail_preparation(error);
    }
    audit.dispatch_prepared()?;
    let vector = audit.dispatch_and_run(
        || {
            let vector = pipeline.embed(prepared)?;
            anyhow::ensure!(
                vector.len() == spec.embedding_dim && vector.iter().all(|value| value.is_finite()),
                "SEMANTIC_DOCUMENT_VECTOR_INVALID"
            );
            Ok(vector)
        },
        |vector| embedding_output_payload(vector),
    )?;
    validate_current(runtime, request, project_id, &identity)?;
    Ok(Nir1DocumentEmbeddingOutcome::Indexed {
        document: document.clone(),
        embedding: embedding_to_le_bytes(&vector, spec.embedding_dim)?,
        identity,
        audit_binding,
    })
}

impl SemanticRuntime {
    /// Identity of the actual loaded pipeline; cache reuse must not infer it
    /// from caller fields or the model catalog alone.
    pub fn nir1_document_embedding_identity(
        &self,
        request: &SemanticRequest,
        project_id: &str,
    ) -> Result<SemanticEmbeddingIdentity> {
        self.nir1_document_embedding_identity_with_control(request, project_id, || Ok(()))
    }

    pub fn nir1_document_embedding_identity_with_control(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        mut check: impl FnMut() -> Result<()>,
    ) -> Result<SemanticEmbeddingIdentity> {
        self.ensure_background_request_current(request)?;
        check()?;
        let spec = strict_project_spec(request, project_id)?;
        self.embedder_admission.background(
            || {
                self.ensure_background_request_current(request)?;
                check()
            },
            || {
                self.with_admitted_embedder(spec, |embedder| {
                    let identity = SemanticEmbeddingIdentity::from_loaded(
                        spec,
                        embedder.model_artifact_identity(),
                        embedder.tokenizer_identity(),
                    );
                    validate_current(self, request, project_id, &identity)?;
                    Ok(identity)
                })
            },
        )
    }

    pub fn embed_nir1_documents(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        documents: &[Nir1EmbeddingDocument],
    ) -> Result<Vec<Nir1DocumentEmbeddingOutcome>> {
        self.embed_nir1_documents_with_control(request, project_id, documents, || Ok(()))
    }

    pub fn embed_nir1_documents_with_control(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        documents: &[Nir1EmbeddingDocument],
        check: impl FnMut() -> Result<()>,
    ) -> Result<Vec<Nir1DocumentEmbeddingOutcome>> {
        self.embed_nir1_documents_with(request, project_id, documents, check, |document, spec| {
            self.with_admitted_embedder(spec, |embedder| {
                embed_document_with(
                    self,
                    request,
                    project_id,
                    document,
                    spec,
                    embedder.model_artifact_identity().clone(),
                    embedder.tokenizer_identity().clone(),
                    embedder,
                )
            })
        })
    }

    pub(super) fn embed_nir1_documents_with(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        documents: &[Nir1EmbeddingDocument],
        mut check: impl FnMut() -> Result<()>,
        mut operation: impl FnMut(
            &Nir1EmbeddingDocument,
            &'static EmbeddingModelSpec,
        ) -> Result<Nir1DocumentEmbeddingOutcome>,
    ) -> Result<Vec<Nir1DocumentEmbeddingOutcome>> {
        self.ensure_background_request_current(request)?;
        check()?;
        let spec = strict_project_spec(request, project_id)?;
        self.embedder_admission.map_background(
            documents,
            || {
                self.ensure_background_request_current(request)?;
                check()
            },
            |document| operation(document, spec),
        )
    }
}
