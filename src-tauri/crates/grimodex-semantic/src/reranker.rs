//! Semantic Recall cross-encoder runtime for diagnostic shadow and opt-in apply.
//!
//! The runtime owns pinned Gate 2 model identities, verifies every local
//! snapshot file before first use, and scores at most 30 frozen candidates.
//! It never performs admission or prompt selection: the renderer remains the
//! owner of the existing dense gate/floor/sparse-rescue policy.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{anyhow, bail, Context, Result};
use ndarray::Array2;
use ort::session::Session;
use ort::value::TensorRef;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokenizers::{
    PaddingDirection, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams,
    TruncationStrategy,
};

pub const RERANKER_SHADOW_SCHEMA_VERSION: u32 = 1;
pub const RERANKER_MAX_CANDIDATES: usize = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RerankerModelSpec {
    pub key: &'static str,
    pub language: &'static str,
    pub model_id: &'static str,
    pub revision: &'static str,
    pub snapshot_relative_path: &'static str,
    pub artifact_relative_path: &'static str,
    pub artifact_sha256: &'static str,
    pub manifest_sha256: &'static str,
    pub needs_token_type_ids: bool,
    pub batch_size: usize,
    pub max_pair_tokens: usize,
    pub thread_count: usize,
}

const JA_XSMALL: RerankerModelSpec = RerankerModelSpec {
    key: "ja_xsmall",
    language: "ja",
    model_id: "hotchpotch/japanese-reranker-xsmall-v2",
    revision: "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
    snapshot_relative_path: "ja_xsmall/de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a/snapshot",
    artifact_relative_path: "onnx/model_qint8_avx2.onnx",
    artifact_sha256: "34d4657df53c875f970dbf87e584a21d59e6cfcd9368f9828d69a09ed152168f",
    manifest_sha256: "8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f",
    needs_token_type_ids: false,
    batch_size: 4,
    max_pair_tokens: 512,
    thread_count: 4,
};

const EN_MINILM_L4: RerankerModelSpec = RerankerModelSpec {
    key: "en_minilm_l4",
    language: "en",
    model_id: "cross-encoder/ms-marco-MiniLM-L4-v2",
    revision: "777b2f369bc1c2f850df8bd367ed1654bda4497b",
    snapshot_relative_path: "en_minilm_l4/777b2f369bc1c2f850df8bd367ed1654bda4497b/snapshot",
    artifact_relative_path: "onnx/model_quint8_avx2.onnx",
    artifact_sha256: "74118ad9ab2b17990c40f03085a91f131339bb3a6d629e96507a6dbf063dae3d",
    manifest_sha256: "e6b043a0b69a61c3b9b54c59ea512149bfa5fbd15ce2778877c283ef4aae9813",
    needs_token_type_ids: true,
    batch_size: 4,
    max_pair_tokens: 512,
    thread_count: 4,
};

pub fn model_spec_for_language(language: &str) -> Result<&'static RerankerModelSpec> {
    match language {
        "ja" => Ok(&JA_XSMALL),
        "en" => Ok(&EN_MINILM_L4),
        other => bail!("unsupported semantic reranker language: {other}"),
    }
}

pub fn sha256_domain_value(domain: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(domain.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hex::encode(hasher.finalize())
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file =
        File::open(path).with_context(|| format!("failed to open reranker file {path:?}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .with_context(|| format!("failed to hash reranker file {path:?}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[derive(Debug, Clone)]
pub struct RerankerCandidate {
    pub candidate_id: String,
    pub text: String,
}

#[derive(Debug, Clone)]
pub struct RerankerRequest {
    pub language: String,
    pub user_message: String,
    pub scene_tail: String,
    pub candidates: Vec<RerankerCandidate>,
}

impl RerankerRequest {
    pub fn validate(&self) -> Result<&'static RerankerModelSpec> {
        let spec = model_spec_for_language(self.language.trim())?;
        if self.user_message.trim().is_empty() && self.scene_tail.trim().is_empty() {
            bail!("semantic reranker query must not be empty");
        }
        if self.candidates.is_empty() || self.candidates.len() > RERANKER_MAX_CANDIDATES {
            bail!("semantic reranker candidates must contain 1..={RERANKER_MAX_CANDIDATES} items");
        }
        let mut ids = HashSet::new();
        for candidate in &self.candidates {
            if candidate.candidate_id.trim().is_empty() {
                bail!("semantic reranker candidateId must not be empty");
            }
            if candidate.text.trim().is_empty() {
                bail!("semantic reranker candidate text must not be empty");
            }
            if !ids.insert(candidate.candidate_id.as_str()) {
                bail!(
                    "semantic reranker candidateId must be unique: {}",
                    candidate.candidate_id
                );
            }
        }
        Ok(spec)
    }

    fn normalized_query(&self) -> (String, usize, Option<usize>) {
        let user_message = self.user_message.trim();
        let scene_tail = self.scene_tail.trim();
        if user_message.is_empty() {
            return (scene_tail.to_string(), 0, Some(0));
        }
        if scene_tail.is_empty() {
            return (user_message.to_string(), user_message.len(), None);
        }
        (
            format!("{user_message}\n{scene_tail}"),
            user_message.len(),
            Some(user_message.len() + 1),
        )
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RerankerTokenizationStats {
    pub query_tokens_before: usize,
    pub query_tokens_after: usize,
    pub candidate_tokens_before: usize,
    pub candidate_tokens_after: usize,
    pub query_truncated: bool,
    pub candidate_truncated: bool,
    pub user_message_tokens_kept: usize,
    pub scene_tail_tokens_kept: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankerCandidateScore {
    pub candidate_id: String,
    pub candidate_hash: String,
    pub score: f32,
    pub tokenization: RerankerTokenizationStats,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RerankerScoreResult {
    pub schema_version: u32,
    pub language: String,
    pub model_id: String,
    pub model_revision: String,
    pub manifest_sha256: String,
    pub query_hash: String,
    pub candidate_set_hash: String,
    pub latency_ms: f64,
    pub model_load_ms: f64,
    pub model_was_cold: bool,
    pub scores: Vec<RerankerCandidateScore>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    algorithm: String,
    files: BTreeMap<String, String>,
    manifest_hash: String,
    schema_version: u32,
}

#[derive(Deserialize)]
struct ModelConfig {
    pad_token_id: i64,
}

#[derive(Deserialize)]
struct TokenizerConfig {
    pad_token: String,
}

struct LoadedReranker {
    tokenizer: Tokenizer,
    count_tokenizer: Tokenizer,
    session: Session,
    output_name: String,
    spec: &'static RerankerModelSpec,
}

impl LoadedReranker {
    fn load(root: &Path, spec: &'static RerankerModelSpec) -> Result<Self> {
        let snapshot = root.join(spec.snapshot_relative_path);
        let revision_root = snapshot
            .parent()
            .ok_or_else(|| anyhow!("reranker snapshot has no revision root"))?;
        let manifest_path = revision_root.join("manifest.json");
        let manifest: SnapshotManifest = serde_json::from_reader(
            File::open(&manifest_path)
                .with_context(|| format!("missing reranker manifest {manifest_path:?}"))?,
        )
        .with_context(|| format!("invalid reranker manifest {manifest_path:?}"))?;
        let computed_manifest_hash =
            hex::encode(Sha256::digest(serde_json::to_vec(&manifest.files)?));
        if manifest.schema_version != 1
            || manifest.algorithm != "sha256"
            || computed_manifest_hash != manifest.manifest_hash
            || manifest.manifest_hash != spec.manifest_sha256
        {
            bail!("reranker manifest identity mismatch for {}", spec.model_id);
        }

        for (relative_path, expected_hash) in &manifest.files {
            let path = snapshot.join(relative_path);
            let actual_hash = sha256_file(&path)?;
            if actual_hash != *expected_hash {
                bail!(
                    "reranker snapshot hash mismatch for {}: expected {}, got {}",
                    relative_path,
                    expected_hash,
                    actual_hash
                );
            }
        }
        if manifest
            .files
            .get(spec.artifact_relative_path)
            .map(String::as_str)
            != Some(spec.artifact_sha256)
        {
            bail!("reranker artifact hash is not pinned by the manifest");
        }

        let model_config: ModelConfig = serde_json::from_reader(
            File::open(snapshot.join("config.json")).context("missing reranker config.json")?,
        )
        .context("invalid reranker config.json")?;
        if model_config.pad_token_id < 0 {
            bail!("reranker pad_token_id must be non-negative");
        }
        let tokenizer_config: TokenizerConfig = serde_json::from_reader(
            File::open(snapshot.join("tokenizer_config.json"))
                .context("missing reranker tokenizer_config.json")?,
        )
        .context("invalid reranker tokenizer_config.json")?;
        if tokenizer_config.pad_token.is_empty() {
            bail!("reranker pad_token must not be empty");
        }

        let tokenizer_path = snapshot.join("tokenizer.json");
        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|error| anyhow!("failed to load reranker tokenizer: {error}"))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: spec.max_pair_tokens,
                strategy: TruncationStrategy::LongestFirst,
                ..Default::default()
            }))
            .map_err(|error| anyhow!("failed to configure reranker truncation: {error}"))?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            direction: PaddingDirection::Right,
            pad_to_multiple_of: None,
            pad_id: model_config.pad_token_id as u32,
            pad_type_id: 0,
            pad_token: tokenizer_config.pad_token,
        }));
        let mut count_tokenizer = tokenizer.clone();
        count_tokenizer
            .with_truncation(None)
            .map_err(|error| anyhow!("failed to disable count-tokenizer truncation: {error}"))?;
        count_tokenizer.with_padding(None);

        let session = Session::builder()
            .context("failed to create reranker ORT SessionBuilder")?
            .with_intra_threads(spec.thread_count)
            .map_err(|error| anyhow!("failed to configure reranker intra-op threads: {error}"))?
            .with_inter_threads(1)
            .map_err(|error| anyhow!("failed to configure reranker inter-op threads: {error}"))?
            .with_memory_pattern(false)
            .map_err(|error| anyhow!("failed to disable reranker memory pattern: {error}"))?
            .with_execution_providers([ort::ep::CPU::default()
                .with_arena_allocator(false)
                .build()
                .error_on_failure()])
            .map_err(|error| anyhow!("failed to configure reranker CPU allocator: {error}"))?
            .commit_from_file(snapshot.join(spec.artifact_relative_path))
            .with_context(|| format!("failed to load reranker model {}", spec.model_id))?;
        let output_name = match session.outputs() {
            [output] if !output.name().is_empty() => output.name().to_string(),
            outputs => bail!(
                "reranker model must expose exactly one named output, got {}",
                outputs.len()
            ),
        };

        Ok(Self {
            tokenizer,
            count_tokenizer,
            session,
            output_name,
            spec,
        })
    }

    fn score(
        &mut self,
        request: &RerankerRequest,
        query: &str,
        user_end: usize,
        scene_tail_start: Option<usize>,
    ) -> Result<Vec<RerankerCandidateScore>> {
        let query_tokens_before = self
            .count_tokenizer
            .encode(query, false)
            .map_err(|error| anyhow!("failed to count reranker query tokens: {error}"))?
            .len();
        let candidate_tokens_before = request
            .candidates
            .iter()
            .map(|candidate| {
                self.count_tokenizer
                    .encode(candidate.text.as_str(), false)
                    .map(|encoding| encoding.len())
                    .map_err(|error| anyhow!("failed to count candidate tokens: {error}"))
            })
            .collect::<Result<Vec<_>>>()?;

        let mut bucketed_indices = (0..request.candidates.len()).collect::<Vec<_>>();
        // Gate 2's promoted evidence buckets by Python `len(chunk_text)`,
        // with original position as the tie-breaker. Preserve that exact batch
        // composition: dynamic padding can slightly change quantized logits.
        bucketed_indices
            .sort_by_key(|&index| (request.candidates[index].text.chars().count(), index));

        let mut results: Vec<Option<RerankerCandidateScore>> = vec![None; request.candidates.len()];
        for batch_indices in bucketed_indices.chunks(self.spec.batch_size) {
            let pairs = batch_indices
                .iter()
                .map(|&index| (query.to_string(), request.candidates[index].text.clone()))
                .collect::<Vec<_>>();
            let encodings = self
                .tokenizer
                .encode_batch(pairs, true)
                .map_err(|error| anyhow!("reranker pair tokenization failed: {error}"))?;
            let seq_len = encodings
                .first()
                .map(|encoding| encoding.len())
                .ok_or_else(|| anyhow!("reranker tokenizer returned an empty batch"))?;
            if seq_len == 0 || encodings.iter().any(|encoding| encoding.len() != seq_len) {
                bail!("reranker token batch has inconsistent padded lengths");
            }

            let input_ids = Array2::<i64>::from_shape_vec(
                (encodings.len(), seq_len),
                encodings
                    .iter()
                    .flat_map(|encoding| encoding.get_ids().iter().map(|&value| value as i64))
                    .collect(),
            )?;
            let attention_mask = Array2::<i64>::from_shape_vec(
                (encodings.len(), seq_len),
                encodings
                    .iter()
                    .flat_map(|encoding| {
                        encoding
                            .get_attention_mask()
                            .iter()
                            .map(|&value| value as i64)
                    })
                    .collect(),
            )?;
            let type_ids = Array2::<i64>::from_shape_vec(
                (encodings.len(), seq_len),
                encodings
                    .iter()
                    .flat_map(|encoding| encoding.get_type_ids().iter().map(|&value| value as i64))
                    .collect(),
            )?;

            let outputs = if self.spec.needs_token_type_ids {
                self.session.run(ort::inputs![
                    "input_ids" => TensorRef::from_array_view(&input_ids)?,
                    "attention_mask" => TensorRef::from_array_view(&attention_mask)?,
                    "token_type_ids" => TensorRef::from_array_view(&type_ids)?,
                ])?
            } else {
                self.session.run(ort::inputs![
                    "input_ids" => TensorRef::from_array_view(&input_ids)?,
                    "attention_mask" => TensorRef::from_array_view(&attention_mask)?,
                ])?
            };
            let output = outputs.get(&self.output_name).ok_or_else(|| {
                anyhow!(
                    "reranker output '{}' is missing from the ORT result",
                    self.output_name
                )
            })?;
            let (shape, logits) = output
                .try_extract_tensor::<f32>()
                .context("reranker output is not an f32 tensor")?;
            let expected = encodings.len();
            let valid_shape = (shape.len() == 1 && shape[0] as usize == expected)
                || (shape.len() == 2 && shape[0] as usize == expected && shape[1] as usize == 1);
            if !valid_shape || logits.len() != expected {
                bail!("reranker must return one logit per pair: shape={shape:?}, batch={expected}");
            }

            for (batch_offset, (&original_index, encoding)) in
                batch_indices.iter().zip(encodings.iter()).enumerate()
            {
                let candidate = &request.candidates[original_index];
                let sequence_ids = encoding.get_sequence_ids();
                let offsets = encoding.get_offsets();
                let mut query_tokens_after = 0;
                let mut candidate_tokens_after = 0;
                let mut user_message_tokens_kept = 0;
                let mut scene_tail_tokens_kept = 0;
                for (token_index, sequence_id) in sequence_ids.iter().enumerate() {
                    match sequence_id {
                        Some(0) => {
                            query_tokens_after += 1;
                            let (start, end) = offsets[token_index];
                            if user_end > 0 && end <= user_end {
                                user_message_tokens_kept += 1;
                            } else if let Some(tail_start) = scene_tail_start {
                                if start >= tail_start {
                                    scene_tail_tokens_kept += 1;
                                }
                            }
                        }
                        Some(1) => candidate_tokens_after += 1,
                        _ => {}
                    }
                }
                let score = logits[batch_offset];
                if !score.is_finite() {
                    bail!("reranker produced a non-finite logit");
                }
                let candidate_hash = sha256_domain_value(
                    "candidate",
                    &format!("{}\0{}", candidate.candidate_id, candidate.text),
                );
                results[original_index] = Some(RerankerCandidateScore {
                    candidate_id: candidate.candidate_id.clone(),
                    candidate_hash,
                    score,
                    tokenization: RerankerTokenizationStats {
                        query_tokens_before,
                        query_tokens_after,
                        candidate_tokens_before: candidate_tokens_before[original_index],
                        candidate_tokens_after,
                        query_truncated: query_tokens_after < query_tokens_before,
                        candidate_truncated: candidate_tokens_after
                            < candidate_tokens_before[original_index],
                        user_message_tokens_kept,
                        scene_tail_tokens_kept,
                    },
                });
            }
        }

        results
            .into_iter()
            .enumerate()
            .map(|(index, result)| {
                result.ok_or_else(|| anyhow!("reranker lost candidate at index {index}"))
            })
            .collect()
    }
}

pub struct RerankerRuntime {
    resource_root: Option<PathBuf>,
    models: HashMap<&'static str, LoadedReranker>,
}

impl RerankerRuntime {
    pub fn new(resource_root: Option<PathBuf>) -> Self {
        Self {
            resource_root,
            models: HashMap::new(),
        }
    }

    pub fn score(&mut self, request: RerankerRequest) -> Result<RerankerScoreResult> {
        let spec = request.validate()?;
        let root = self
            .resource_root
            .as_deref()
            .ok_or_else(|| anyhow!("semantic reranker resources are not configured"))?;
        let total_started = Instant::now();
        let model_was_cold = !self.models.contains_key(spec.key);
        let load_started = Instant::now();
        if model_was_cold {
            let model = LoadedReranker::load(root, spec)?;
            self.models.insert(spec.key, model);
        }
        let model_load_ms = if model_was_cold {
            load_started.elapsed().as_secs_f64() * 1000.0
        } else {
            0.0
        };
        let (query, user_end, scene_tail_start) = request.normalized_query();
        let query_hash = sha256_domain_value(spec.language, &query);
        let model = self
            .models
            .get_mut(spec.key)
            .ok_or_else(|| anyhow!("semantic reranker cache lost {}", spec.key))?;
        let scores = model.score(&request, &query, user_end, scene_tail_start)?;
        let candidate_set_hash = sha256_domain_value(
            "candidate-set",
            &scores
                .iter()
                .map(|score| score.candidate_hash.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        Ok(RerankerScoreResult {
            schema_version: RERANKER_SHADOW_SCHEMA_VERSION,
            language: spec.language.to_string(),
            model_id: spec.model_id.to_string(),
            model_revision: spec.revision.to_string(),
            manifest_sha256: spec.manifest_sha256.to_string(),
            query_hash,
            candidate_set_hash,
            latency_ms: total_started.elapsed().as_secs_f64() * 1000.0,
            model_load_ms,
            model_was_cold,
            scores,
        })
    }
}
