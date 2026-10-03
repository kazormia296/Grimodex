use super::*;
use crate::audit::{
    embedding_output_payload, sha256_hex, ModelArtifactIdentity, TokenizerIdentity,
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEmbeddingIdentity {
    pub model_id: String,
    pub artifact_sha256: String,
    pub tokenizer_sha256: String,
    pub embedding_dim: usize,
    pub chunker_version: String,
}

impl SemanticEmbeddingIdentity {
    pub(super) fn from_loaded(
        spec: &EmbeddingModelSpec,
        model: &ModelArtifactIdentity,
        tokenizer: &TokenizerIdentity,
    ) -> Self {
        Self {
            model_id: spec.full_model_id(),
            artifact_sha256: model.sha256.clone(),
            tokenizer_sha256: tokenizer.sha256.clone(),
            embedding_dim: spec.embedding_dim,
            chunker_version: spec.chunker_version.into(),
        }
    }

    pub(super) fn matches_spec(&self, spec: &EmbeddingModelSpec) -> bool {
        self.model_id == spec.full_model_id()
            && self.artifact_sha256 == spec.artifact_sha256
            && self.embedding_dim == spec.embedding_dim
            && self.chunker_version == spec.chunker_version
    }
}

pub(super) fn strict_project_spec(
    request: &SemanticRequest,
    project_id: &str,
) -> Result<&'static EmbeddingModelSpec> {
    let language = request
        .db()
        .with_conn(|connection| {
            connection
                .query_row(
                    "SELECT language FROM projects WHERE id = ?",
                    params![project_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(Into::into)
        })?
        .ok_or_else(|| anyhow!("SEMANTIC_QUERY_PROJECT_UNAVAILABLE"))?;
    Ok(spec_for_language(&language))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticEmbeddingAuditBinding {
    pub operation_id: String,
    pub execution_id: String,
}

/// Request-local capability. Neither the latent vector nor a constructor is
/// exported; only the runtime that pinned it can consume it after validation.
/// Shells must keep this behind their bounded, authority-bound operation ticket.
pub struct AuditedSemanticQuery {
    request: SemanticRequest,
    project_id: String,
    input_sha256: String,
    identity: SemanticEmbeddingIdentity,
    audit: SemanticEmbeddingAuditBinding,
    vector: Vec<f32>,
}

impl AuditedSemanticQuery {
    pub fn model_identity(&self) -> &SemanticEmbeddingIdentity {
        &self.identity
    }
    pub fn audit_binding(&self) -> &SemanticEmbeddingAuditBinding {
        &self.audit
    }
    pub fn input_sha256(&self) -> &str {
        &self.input_sha256
    }
    pub fn project_id(&self) -> &str {
        &self.project_id
    }
    pub fn epoch_generation(&self) -> u64 {
        self.request.epoch.generation
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_query_with(
    runtime: &SemanticRuntime,
    request: &SemanticRequest,
    project_id: &str,
    query: &str,
    raw_limit: usize,
    spec: &'static EmbeddingModelSpec,
    model: ModelArtifactIdentity,
    tokenizer: TokenizerIdentity,
    inference: impl FnOnce() -> Result<Vec<f32>>,
) -> Result<AuditedSemanticQuery> {
    runtime.ensure_background_request_current(request)?;
    let identity = SemanticEmbeddingIdentity::from_loaded(spec, &model, &tokenizer);
    anyhow::ensure!(
        identity.matches_spec(strict_project_spec(request, project_id)?),
        "SEMANTIC_QUERY_MODEL_CHANGED"
    );
    let mut audit = start_embedding_audit(
        request,
        project_id,
        AuditedEmbeddingInput {
            path_id: "semantic_search",
            inference_kind: "embedding.query",
            spec,
            model_artifact_identity: model,
            tokenizer_identity: tokenizer,
            raw_text: query,
            model_prefix: spec.query_prefix,
            metadata: json!({
                "domain": "scene", "sceneScope": null, "descriptionMode": false,
                "requestedLimit": raw_limit,
                "sharedConsumers": ["raw-related-scenes", "nir1-related-scenes"],
            }),
        },
        true,
        false,
    )?;
    let execution_id = audit.execution_id().to_string();
    let vector = audit.dispatch_and_run(
        || {
            let vector = inference()?;
            anyhow::ensure!(
                vector.len() == spec.embedding_dim && vector.iter().all(|v| v.is_finite()),
                "SEMANTIC_QUERY_VECTOR_INVALID"
            );
            Ok(vector)
        },
        |vector| embedding_output_payload(vector),
    )?;
    let query = AuditedSemanticQuery {
        request: request.clone(),
        project_id: project_id.to_string(),
        input_sha256: sha256_hex(query.as_bytes()),
        identity,
        audit: SemanticEmbeddingAuditBinding {
            operation_id: request.operation_id.clone(),
            execution_id,
        },
        vector,
    };
    runtime.validate_audited_query_current(&query)?;
    Ok(query)
}

impl SemanticRuntime {
    pub fn prepare_related_scene_query(
        &self,
        request: &SemanticRequest,
        project_id: &str,
        query: &str,
        raw_limit: usize,
    ) -> Result<AuditedSemanticQuery> {
        self.ensure_background_request_current(request)?;
        let spec = strict_project_spec(request, project_id)?;
        self.with_embedder(spec, |embedder| {
            prepare_query_with(
                self,
                request,
                project_id,
                query,
                raw_limit,
                spec,
                embedder.model_artifact_identity().clone(),
                embedder.tokenizer_identity().clone(),
                || embedder.embed_query(query),
            )
        })
    }

    /// This supplements the shell's workspace authority and the DB's sealed
    /// index/roster checks. It does not establish narrative admission by itself.
    pub fn validate_audited_query_current(&self, query: &AuditedSemanticQuery) -> Result<()> {
        let current = self.snapshot_epoch();
        anyhow::ensure!(
            current.generation == query.request.epoch.generation
                && Arc::ptr_eq(&current.caches, &query.request.epoch.caches),
            "SEMANTIC_QUERY_STALE"
        );
        let spec = strict_project_spec(&query.request, &query.project_id)?;
        anyhow::ensure!(
            query.identity.matches_spec(spec),
            "SEMANTIC_QUERY_MODEL_CHANGED"
        );
        Ok(())
    }

    pub fn semantic_search_with_query(
        &self,
        query: &AuditedSemanticQuery,
        limit: usize,
        scene_scope: Option<&str>,
        description_mode: Option<bool>,
    ) -> Result<Vec<SearchHit>> {
        self.validate_audited_query_current(query)?;
        let hits = run_search(
            query.request.db(),
            &query.request.epoch.caches.scene,
            &query.vector,
            &query.project_id,
            scene_scope,
            limit,
            description_mode.unwrap_or(false),
            &query.identity.model_id,
            query.identity.embedding_dim,
            &query.identity.chunker_version,
        )?;
        self.validate_audited_query_current(query)?;
        Ok(hits)
    }

    /// Call only with the DB's admitted pool after its current Index/roster
    /// check. This method neither acquires the embedder mutex nor runs inference.
    pub fn score_accepted_documents(
        &self,
        query: &AuditedSemanticQuery,
        identity: &SemanticEmbeddingIdentity,
        vectors: &[&[u8]],
    ) -> Result<Vec<f32>> {
        self.validate_audited_query_current(query)?;
        anyhow::ensure!(&query.identity == identity, "SEMANTIC_QUERY_MODEL_MISMATCH");
        let mut scores = Vec::with_capacity(vectors.len());
        for bytes in vectors {
            anyhow::ensure!(
                bytes.len() == identity.embedding_dim * 4,
                "SEMANTIC_DOCUMENT_VECTOR_INVALID"
            );
            let vector: Vec<f32> = bytes
                .as_chunks::<4>()
                .0
                .iter()
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .collect();
            anyhow::ensure!(
                vector.iter().all(|value| value.is_finite()),
                "SEMANTIC_DOCUMENT_VECTOR_INVALID"
            );
            let score = crate::embedding::cosine_similarity(&query.vector, &vector);
            anyhow::ensure!(score.is_finite(), "SEMANTIC_DOCUMENT_SCORE_INVALID");
            scores.push(score);
        }
        self.validate_audited_query_current(query)?;
        Ok(scores)
    }
}
