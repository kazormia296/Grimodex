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
    /// Maximum input length (in tokens) the ONNX graph accepts. The tokenizer is
    /// configured to truncate to this so an input longer than the model's
    /// position table never reaches inference. Plain BERT (bge) has a fixed
    /// 512-entry position embedding; feeding it >512 tokens makes the
    /// `/embeddings/Add_1` (word+position) broadcast fail at runtime
    /// ("Attempting to broadcast an axis ... 512 by N"). ruri (ModernBERT)
    /// supports 8192, so Japanese chunks (~760 tokens) are never truncated and
    /// existing ja embeddings stay byte-identical.
    pub max_seq_len: usize,
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

    // --- On-demand download metadata (registry; consumed by the model downloader) ---
    // These describe where the *calibrated* int8 `model_int8.onnx` for this spec
    // lives so a build/runtime that lacks the bundled resource can fetch it. They
    // are pure附随情報 and MUST NOT affect `full_model_id()` / byte-stability.
    //
    /// Public HTTPS URL of the calibrated int8 ONNX (a GitHub Release asset). The
    /// downloaded bytes MUST sha256-match `artifact_sha256` — a mismatch means a
    /// different quantization and would silently invalidate the RAG calibration,
    /// so the downloader rejects it. Empty string = no download source configured.
    pub artifact_url: &'static str,
    /// Lowercase hex sha256 of the exact int8 artifact the model was calibrated
    /// against. Pinned here so "this identifier's chunks were built from this
    /// exact artifact" is a fixed invariant (see docs/設計_埋め込みモデルのオンデマンドDL.md §2.3).
    pub artifact_sha256: &'static str,
    /// Expected byte size of the int8 artifact (progress denominator + DoS hard cap).
    pub artifact_size: u64,
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
    // ModernBERT / RoPE: documented 8192. ja chunks tokenize to ~760, so this
    // never truncates — capping lower would silently change every ja embedding.
    max_seq_len: 8192,
    chunker_version: CHUNKER_VERSION,
    model_id_suffix: "@local/model_int8.onnx/prefix-v1",
    golden_fixture: "ruri_v3_30m_golden.json",
    // int8 は非同梱 (tokenizer のみ同梱)。JA も EN 同様、初回利用時にここから
    // オンデマンド DL する。pinned to the semantic-models-v1 Release asset.
    artifact_url:
        "https://github.com/kazormia296/Grimodex/releases/download/semantic-models-v1/ruri-v3-30m-model_int8.onnx",
    artifact_sha256: "946ae837c9cd3f78baf93af541e77facec62d31049921d7c00fbcb57b4610bcf",
    artifact_size: 37_074_051,
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
    // Plain BERT: fixed 512-entry position table. Inputs >512 tokens crash the
    // position-embedding add. Hit when Japanese text is indexed in an English
    // project (each CJK char ≈ 1 bge token, so 1000-char chunks blow past 512).
    max_seq_len: 512,
    chunker_version: CHUNKER_VERSION_EN,
    model_id_suffix: "@local/model_int8.onnx/en-v1",
    golden_fixture: "bge_small_en_v15_golden.json",
    // int8 は非同梱: 初回利用時に app_data へオンデマンド DL する。
    // pinned to the semantic-models-v1 Release asset.
    artifact_url:
        "https://github.com/kazormia296/Grimodex/releases/download/semantic-models-v1/bge-small-en-v15-model_int8.onnx",
    artifact_sha256: "4f1831710bec8904589cf50c58ad4d9ed3e66386f4973173c13f1e9d3ae8e44b",
    artifact_size: 34_041_756,
};

/// 現行の全 spec。オンデマンド DL 済みモデルの GC で「残すべき dir_name」の集合として
/// 使う (ここに無い `app_data/models/<dir>` は旧モデルとして掃除対象)。モデルを
/// 増やす/差し替える際はここも更新する。
pub static ALL_SPECS: [&EmbeddingModelSpec; 2] = [&SPEC_JA, &SPEC_EN];

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
        // ruri must keep its full context: capping lower would truncate ja
        // chunks (~760 tokens) and silently change every existing ja embedding.
        assert_eq!(SPEC_JA.max_seq_len, 8192);
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

    fn is_lower_hex64(s: &str) -> bool {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }

    #[test]
    fn download_metadata_is_well_formed() {
        for spec in [&SPEC_JA, &SPEC_EN] {
            // A configured artifact must be an https GitHub Release asset with a
            // valid pinned sha256 and non-zero size (progress denominator / DoS cap).
            assert!(
                spec.artifact_url.starts_with("https://github.com/"),
                "artifact_url must be an https GitHub URL: {}",
                spec.artifact_url
            );
            assert!(
                spec.artifact_url.contains("/releases/download/"),
                "artifact_url must be a Release asset: {}",
                spec.artifact_url
            );
            assert!(
                is_lower_hex64(spec.artifact_sha256),
                "artifact_sha256 must be 64 lowercase hex chars: {}",
                spec.artifact_sha256
            );
            assert!(spec.artifact_size > 0);
        }
        // The download metadata must never leak into the staleness identifier.
        assert_eq!(
            SPEC_JA.full_model_id(),
            "cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1"
        );
    }

    #[test]
    fn en_spec_matches_calibrated_bge() {
        // bge-small-en-v1.5: plain BERT → CLS pooling + token_type_ids.
        assert_eq!(SPEC_EN.model_id, "BAAI/bge-small-en-v1.5");
        assert_eq!(SPEC_EN.pooling, Pooling::Cls);
        assert!(SPEC_EN.needs_token_type_ids);
        assert_eq!(SPEC_EN.embedding_dim, 384);
        // bge's position table is 512 entries; the tokenizer truncates here so
        // over-long (e.g. Japanese-in-en-project) chunks never crash inference.
        assert_eq!(SPEC_EN.max_seq_len, 512);
    }
}
