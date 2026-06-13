//! Per-language embedding-model specifications.
//!
//! Grimodex runs a two-model setup: Japanese projects keep `ruri-v3-30m`
//! (unchanged), English projects use a dedicated English model. A project's
//! `language` column selects the spec; the resulting `model_id` / dim /
//! `chunker_version` are written into `scene_chunks` so switching a project's
//! language (or the model) marks its chunks stale and `semantic_reindex_all`
//! rebuilds them. Japanese identifiers must never change (regression-locked by
//! the unit test below) so existing indexes are not invalidated.
//!
//! The English spec's concrete values (model id, dim, pooling) are finalised by
//! the host calibration step (`scripts/calibrate-embedding-threshold.py` +
//! `scripts/export-ruri-onnx.py`); the values here track the recommended
//! candidate (granite-embedding-small-english-r2). See
//! `docs/Grimodex_英語対応検討.md`.
//!
//! 消費側 (`embedding` / `commands::semantic` / `index` の embed 経路) は
//! `semantic-embedding` feature 内なので、`--no-default-features` ビルドでは
//! 本モジュールは ja-invariant テスト以外「未使用」に見える。ort 無しで
//! container テストできる利点を優先して非 gate のままにし、非 default ビルドの
//! 偽陽性 dead_code だけ allow する。
#![allow(dead_code)]

// NOTE: SPEC_JA uses literal values (not `embedding` constants) so this module
// stays buildable without the `semantic-embedding` feature — letting the
// ja-regression test run under `cargo test --no-default-features`. A
// feature-gated test in `embedding.rs` cross-checks these against the real
// constants so the two can never silently drift.
use crate::semantic::chunker::{ChunkerConfig, CHUNKER_VERSION};

/// How an ONNX model's per-token hidden states are reduced to one vector.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pooling {
    /// attention-mask-weighted mean over all tokens (ruri / e5 style).
    MeanWithMask,
    /// take the first token's hidden state (BERT/ModernBERT CLS; bge / granite).
    Cls,
}

/// Everything language/model-specific the embedding pipeline needs.
#[derive(Debug, Clone, Copy)]
pub struct EmbeddingModelSpec {
    /// Base model id (also the prefix of `scene_chunks.model_id`).
    pub model_id: &'static str,
    /// Directory under `resources/semantic/` holding the ONNX + tokenizer.
    pub dir_name: &'static str,
    /// Output dimensionality (ruri=256, granite/bge=384).
    pub embedding_dim: usize,
    /// Query prefix prepended before embedding (empty for prefix-free models).
    pub query_prefix: &'static str,
    /// Document prefix prepended before embedding.
    pub document_prefix: &'static str,
    pub pooling: Pooling,
    /// Whether the ONNX graph requires a (zeroed) `token_type_ids` input.
    /// false for ModernBERT (ruri/granite); true for plain BERT (bge/e5).
    pub needs_token_type_ids: bool,
    /// Chunker version string written to `scene_chunks.chunker_version`. The
    /// English chunker uses its own value so changing it never restages
    /// Japanese scenes.
    pub chunker_version: &'static str,
    /// Suffix appended to `model_id` to form the full `scene_chunks.model_id`.
    pub model_id_suffix: &'static str,
    /// Golden fixture filename under `tests/fixtures/`. Only read by the
    /// (feature-gated) golden test, so a plain `cargo check` sees it unused.
    #[allow(dead_code)]
    pub golden_fixture: &'static str,
}

impl EmbeddingModelSpec {
    /// Full identifier written to `scene_chunks.model_id`.
    pub fn full_model_id(&self) -> String {
        format!("{}{}", self.model_id, self.model_id_suffix)
    }

    /// Chunker configuration tuned for the spec's language.
    pub fn chunker_config(&self) -> ChunkerConfig {
        if self.pooling == Pooling::MeanWithMask && self.chunker_version == CHUNKER_VERSION {
            // Japanese: keep the existing defaults verbatim.
            ChunkerConfig::default()
        } else {
            // English: text is less information-dense per character, so chunk
            // targets are ~2x and dialogue tags a little longer.
            ChunkerConfig {
                target_min_chars: 400,
                target_max_chars: 1000,
                overlap_sentences: 1,
                dialogue_tag_max_chars: 120,
            }
        }
    }
}

/// Japanese spec — values must stay byte-identical to the pre-refactor
/// constants (regression-locked below).
pub static SPEC_JA: EmbeddingModelSpec = EmbeddingModelSpec {
    model_id: "cl-nagoya/ruri-v3-30m",
    dir_name: "ruri-v3-30m",
    embedding_dim: 256,
    query_prefix: "検索クエリ: ",
    document_prefix: "検索文書: ",
    pooling: Pooling::MeanWithMask,
    needs_token_type_ids: false,
    chunker_version: CHUNKER_VERSION,
    model_id_suffix: "@local/model_int8.onnx/prefix-v1",
    golden_fixture: "ruri_v3_30m_golden.json",
};

/// English chunker version — independent of the Japanese one so English-only
/// changes never restage Japanese scenes.
pub const CHUNKER_VERSION_EN: &str = "semantic-prose-chunker-en-v1";

/// English spec — finalised to bge-small-en-v1.5 by the host calibration
/// (scripts/calibrate-embedding-threshold.py, 36-pair corpus). bge beat
/// granite on Recall@3 (0.89 vs 0.81), MRR (0.78 vs 0.75) and the operating
/// point (recall 0.86 @ fp 0.048 vs 0.81 @ 0.101), and is smaller (~34MB int8) +
/// MIT. It is a plain BERT: **CLS pooling** (confirmed via the ST Pooling
/// config `pooling_mode='cls'`) and it needs a (zeroed) `token_type_ids`
/// input. No query/document prefix. RAG threshold: SEMANTIC_RECALL_MIN_SCORE_EN
/// = 0.51 (semanticRecall.ts).
pub static SPEC_EN: EmbeddingModelSpec = EmbeddingModelSpec {
    model_id: "BAAI/bge-small-en-v1.5",
    dir_name: "bge-small-en-v15",
    embedding_dim: 384,
    query_prefix: "",
    document_prefix: "",
    pooling: Pooling::Cls,
    needs_token_type_ids: true,
    chunker_version: CHUNKER_VERSION_EN,
    model_id_suffix: "@local/model_int8.onnx/en-v1",
    golden_fixture: "bge_small_en_v15_golden.json",
};

/// Pick the model spec for a project language. Anything that is not English
/// falls back to the Japanese (ruri) spec.
pub fn spec_for_language(language: &str) -> &'static EmbeddingModelSpec {
    if language.starts_with("en") {
        &SPEC_EN
    } else {
        &SPEC_JA
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Japanese identifiers are load-bearing: changing any of them would mark
    /// every existing ja `scene_chunks` row stale and force a full reindex.
    #[test]
    fn ja_spec_is_byte_stable() {
        assert_eq!(
            SPEC_JA.full_model_id(),
            "cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1"
        );
        assert_eq!(SPEC_JA.chunker_version, "semantic-prose-chunker-v1");
        assert_eq!(SPEC_JA.embedding_dim, 256);
        assert_eq!(SPEC_JA.query_prefix, "検索クエリ: ");
        assert_eq!(SPEC_JA.document_prefix, "検索文書: ");
        assert_eq!(SPEC_JA.pooling, Pooling::MeanWithMask);
        assert!(!SPEC_JA.needs_token_type_ids);
    }

    #[test]
    fn spec_selection_by_language() {
        assert_eq!(spec_for_language("ja").dir_name, "ruri-v3-30m");
        assert_eq!(spec_for_language("en").dir_name, "bge-small-en-v15");
        assert_eq!(spec_for_language("zh").dir_name, "ruri-v3-30m");
    }

    #[test]
    fn en_uses_independent_chunker_version() {
        assert_ne!(SPEC_EN.chunker_version, SPEC_JA.chunker_version);
    }

    #[test]
    fn en_spec_matches_calibrated_bge() {
        // bge-small-en-v1.5: plain BERT → CLS pooling + token_type_ids.
        assert_eq!(SPEC_EN.model_id, "BAAI/bge-small-en-v1.5");
        assert_eq!(SPEC_EN.pooling, Pooling::Cls);
        assert!(SPEC_EN.needs_token_type_ids);
        assert_eq!(SPEC_EN.embedding_dim, 384);
    }
}
