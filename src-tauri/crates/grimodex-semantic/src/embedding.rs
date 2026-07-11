//! ruri-v3-30m ONNX 推論パイプライン。
//! 設計: temp/semantic-prose-search-context.md §2.1〜§2.3。
//!
//! 流れ:
//!   1. text に検索クエリ / 検索文書 prefix を付与。
//!   2. HF tokenizer で input_ids, attention_mask に変換 (ModernBERT 系のため
//!      token_type_ids は不要)。
//!   3. ort で last_hidden_state を取得。
//!   4. attention_mask 重み付きで prefix トークンも含めた mean pool
//!      (include_prompt=True 相当)。
//!   5. L2 正規化して f32 ベクトルを返す。
//!
//! Step 6 で Tauri command に配線されるまで外部から呼ばれないため
//! crate 内 dead_code を許容する。
//!
//! ort 2.x の正確な型シグネチャは breaking change が多いため、cargo check が
//! 通る最新マイナーで微調整する可能性あり。pure-logic 部分 (mean pool, L2
//! norm, cosine) は本ファイル末尾の unit test で固定する。

#![allow(dead_code)]

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use ndarray::Array2;
use ort::session::Session;
use ort::value::TensorRef;
use tokenizers::{Tokenizer, TruncationParams};

use crate::spec::{EmbeddingModelSpec, Pooling};

/// ruri-v3 の検索クエリ用 prefix。検索時の入力に付与する。
pub const QUERY_PREFIX: &str = "検索クエリ: ";
/// ruri-v3 の検索対象文書用 prefix。インデックス時のチャンクに付与する。
pub const DOCUMENT_PREFIX: &str = "検索文書: ";

/// 採用モデル ID。`scene_chunks.model_id` の prefix としても使う。
pub const MODEL_ID_RURI_V3_30M: &str = "cl-nagoya/ruri-v3-30m";
/// ruri-v3-30m の出力次元 (モデルカード確認済み)。
pub const EMBEDDING_DIM_RURI_V3_30M: usize = 256;

/// ruri-v3 ONNX inference を保持する struct。Tauri 起動時に 1 度だけ
/// `load()` して以後使い回す前提 (Session の再構築はコストが大きい)。
pub struct Embedder {
    tokenizer: Tokenizer,
    session: Session,
    spec: &'static EmbeddingModelSpec,
}

impl Embedder {
    /// 量子化 ONNX と tokenizer.json を読み込む。`spec` がモデルの次元・prefix・
    /// pooling・token_type_ids 要否を決める (言語ごとに切替)。
    pub fn load(
        model_path: &Path,
        tokenizer_path: &Path,
        spec: &'static EmbeddingModelSpec,
    ) -> Result<Self> {
        let mut tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| anyhow!("failed to load tokenizer at {:?}: {e}", tokenizer_path))?;
        // The Rust `tokenizers` crate does NOT honour `model_max_length` from
        // tokenizer_config.json, so by default every input is tokenized in full.
        // Plain BERT models (bge) have a fixed 512-entry position table; a longer
        // input makes the `/embeddings/Add_1` (word+position) broadcast fail at
        // inference ("Attempting to broadcast an axis ... 512 by N"). This bit
        // when Japanese prose was indexed in an English project (each CJK char ≈
        // 1 bge token). Truncate to the spec's max so over-long chunks are capped
        // instead of crashing. max_length accounts for the post-processor's
        // special tokens, so the final sequence (incl. CLS/SEP) stays ≤ max.
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: spec.max_seq_len,
                ..Default::default()
            }))
            .map_err(|e| anyhow!("failed to configure tokenizer truncation: {e}"))?;
        let session = Session::builder()
            .context("failed to create ort SessionBuilder")?
            .commit_from_file(model_path)
            .with_context(|| format!("failed to load ONNX model at {:?}", model_path))?;
        Ok(Self {
            tokenizer,
            session,
            spec,
        })
    }

    /// 検索クエリを spec の query prefix 込みで埋め込み、L2 正規化済み f32 を返す。
    /// prefix が空文字のモデル (granite / bge) では prefix 無しになる。
    /// `Session::run` が `&mut self` を要求するため Embedder 自体も `&mut`。Tauri 配線時は
    /// `Mutex<Embedder>` 等で包む前提。
    pub fn embed_query(&mut self, text: &str) -> Result<Vec<f32>> {
        let prefixed = format!("{}{}", self.spec.query_prefix, text);
        self.embed_prefixed(&prefixed)
    }

    /// 文書チャンクを spec の document prefix 込みで埋め込み、L2 正規化済み f32 を返す。
    pub fn embed_document(&mut self, text: &str) -> Result<Vec<f32>> {
        let prefixed = format!("{}{}", self.spec.document_prefix, text);
        self.embed_prefixed(&prefixed)
    }

    /// prefix を**呼び出し側で既に付与した文字列**を入力に取り、埋め込みベクトルを返す。
    /// テストや golden 比較から prefix の二重付与を避けたいときに使う。
    pub fn embed_prefixed(&mut self, prefixed: &str) -> Result<Vec<f32>> {
        let encoding = self
            .tokenizer
            .encode(prefixed, true) // add_special_tokens=true (CLS/SEP 自動付与)
            .map_err(|e| anyhow!("tokenization failed: {e}"))?;

        let ids = encoding.get_ids();
        let mask = encoding.get_attention_mask();
        let seq_len = ids.len();
        if seq_len == 0 {
            return Err(anyhow!("tokenizer returned empty sequence for input"));
        }

        let input_ids =
            Array2::<i64>::from_shape_vec((1, seq_len), ids.iter().map(|&i| i as i64).collect())?;
        let attention_mask =
            Array2::<i64>::from_shape_vec((1, seq_len), mask.iter().map(|&m| m as i64).collect())?;

        // ort 2.x: TensorRef::from_array_view でゼロコピー入力を作る。
        // ModernBERT 系 (ruri / granite) は input_ids + attention_mask の 2 入力。
        // 素の BERT 系 (bge / e5) は token_type_ids (全 0) を加えた 3 入力を要求する。
        let outputs = if self.spec.needs_token_type_ids {
            let token_type_ids = Array2::<i64>::zeros((1, seq_len));
            self.session.run(ort::inputs![
                "input_ids" => TensorRef::from_array_view(&input_ids)?,
                "attention_mask" => TensorRef::from_array_view(&attention_mask)?,
                "token_type_ids" => TensorRef::from_array_view(&token_type_ids)?,
            ])?
        } else {
            self.session.run(ort::inputs![
                "input_ids" => TensorRef::from_array_view(&input_ids)?,
                "attention_mask" => TensorRef::from_array_view(&attention_mask)?,
            ])?
        };

        // per-token の hidden state を取り出す。出力名はエクスポート方式で揺れる:
        //   - `last_hidden_state`: HuggingFace optimum の feature-extraction task で出すと
        //     こうなる。自前 export (scripts/export-ruri-onnx.py) はこちら。
        //   - `token_embeddings`: SentenceTransformer 全体を ONNX 化した変種。
        //     sirasagi62/ruri-v3-30m-ONNX はこちらで、`sentence_embedding`
        //     (pool+norm 済み) も同時に出力する。
        //
        // 本実装は per-token 出力に対して Rust 側で mean pool + L2 normalize を行う
        // (§2.2: pooling と normalize の正しさを golden test で検証する責務を Rust に持たせる)。
        // sentence_embedding を直接使うと「Rust の pooling/norm を一切走らせない」状態に
        // なり、検証の意味が消えるため意図的に採用しない。
        let raw = outputs
            .get("last_hidden_state")
            .or_else(|| outputs.get("token_embeddings"))
            .ok_or_else(|| {
                let names: Vec<String> = outputs.keys().map(|k| k.to_string()).collect();
                anyhow!(
                    "ort: per-token output ('last_hidden_state' or 'token_embeddings') \
                     not found; got {names:?}"
                )
            })?;

        let (shape, data) = raw
            .try_extract_tensor::<f32>()
            .map_err(|e| anyhow!("could not extract f32 output: {e}"))?;

        // 期待 shape: [batch=1, seq_len, hidden_dim]
        if shape.len() != 3 {
            return Err(anyhow!(
                "unexpected last_hidden_state rank: shape={:?}",
                shape
            ));
        }
        let batch = shape[0] as usize;
        let out_seq_len = shape[1] as usize;
        let hidden_dim = shape[2] as usize;
        if batch != 1 {
            return Err(anyhow!("expected batch=1, got {batch}"));
        }
        if out_seq_len != seq_len {
            return Err(anyhow!(
                "ONNX seq_len {out_seq_len} != tokenizer seq_len {seq_len}"
            ));
        }
        if hidden_dim != self.spec.embedding_dim {
            return Err(anyhow!(
                "ONNX hidden_dim {hidden_dim} != configured embedding_dim {}",
                self.spec.embedding_dim
            ));
        }

        let mut pooled = match self.spec.pooling {
            Pooling::MeanWithMask => mean_pool_with_mask(data, mask, hidden_dim),
            Pooling::Cls => cls_pool(data, hidden_dim),
        };
        l2_normalize_in_place(&mut pooled);
        Ok(pooled)
    }

    pub fn embedding_dim(&self) -> usize {
        self.spec.embedding_dim
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// pure-logic helpers (テスト容易性のため Embedder から切り出す)
// ─────────────────────────────────────────────────────────────────────────────

/// attention_mask 重み付きで全トークン (prefix 込み) を mean pool。
/// `hidden` は [seq_len, hidden_dim] row-major flat。
/// `mask` の要素が 0 のトークンは平均から除外する (padding 用)。
/// SentenceTransformer の Pooling(include_prompt=True) と一致する挙動。
pub fn mean_pool_with_mask(hidden: &[f32], mask: &[u32], hidden_dim: usize) -> Vec<f32> {
    debug_assert_eq!(
        hidden.len(),
        mask.len() * hidden_dim,
        "hidden flat size {} != seq_len {} * hidden_dim {}",
        hidden.len(),
        mask.len(),
        hidden_dim
    );
    let mut sum = vec![0.0f32; hidden_dim];
    let mut count: f32 = 0.0;
    for (t, &m) in mask.iter().enumerate() {
        if m == 0 {
            continue;
        }
        let base = t * hidden_dim;
        for d in 0..hidden_dim {
            sum[d] += hidden[base + d];
        }
        count += 1.0;
    }
    if count > 0.0 {
        for s in sum.iter_mut() {
            *s /= count;
        }
    }
    sum
}

/// CLS pooling: 先頭トークン (index 0) の hidden state をそのまま返す。
/// bge / granite 系の SentenceTransformer 既定 pooling と一致する。
/// `hidden` は [seq_len, hidden_dim] row-major flat。
pub fn cls_pool(hidden: &[f32], hidden_dim: usize) -> Vec<f32> {
    if hidden.len() < hidden_dim {
        return vec![0.0; hidden_dim];
    }
    hidden[..hidden_dim].to_vec()
}

/// in-place L2 正規化。零ベクトルはそのまま (NaN 回避)。
pub fn l2_normalize_in_place(v: &mut [f32]) {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// 2 つの f32 ベクトルのコサイン類似度。長さ不一致は panic (呼び出し側のバグ)。
/// 0 ベクトル混入時は 0.0 を返す (NaN 回避)。
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(
        a.len(),
        b.len(),
        "cosine_similarity: dim mismatch ({} vs {})",
        a.len(),
        b.len()
    );
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na < f32::EPSILON || nb < f32::EPSILON {
        0.0
    } else {
        dot / (na * nb)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// tests (pure-logic 部分のみ。Session 経路は tests/embedding_golden.rs で
//        gated に検証する)
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn approx_eq(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    // ── mean_pool_with_mask ──────────────────────────────────────────────

    #[test]
    fn mean_pool_uniform_mask_averages_all_tokens() {
        // seq_len=3, hidden_dim=2。全 mask=1 → 単純平均
        let hidden = vec![
            1.0, 2.0, // token 0
            3.0, 4.0, // token 1
            5.0, 6.0, // token 2
        ];
        let mask = vec![1u32, 1, 1];
        let pooled = mean_pool_with_mask(&hidden, &mask, 2);
        assert_eq!(pooled, vec![3.0, 4.0]);
    }

    #[test]
    fn mean_pool_skips_zero_masked_tokens() {
        // padding トークンは除外。token1 を 0 にすると残り 2 トークンの平均。
        let hidden = vec![1.0, 2.0, 100.0, 200.0, 5.0, 6.0];
        let mask = vec![1u32, 0, 1];
        let pooled = mean_pool_with_mask(&hidden, &mask, 2);
        assert_eq!(pooled, vec![3.0, 4.0]);
    }

    #[test]
    fn mean_pool_all_zero_mask_yields_zero_vector() {
        let hidden = vec![1.0, 2.0, 3.0, 4.0];
        let mask = vec![0u32, 0];
        let pooled = mean_pool_with_mask(&hidden, &mask, 2);
        assert_eq!(pooled, vec![0.0, 0.0]);
    }

    #[test]
    fn mean_pool_includes_prefix_tokens_when_masked_one() {
        // include_prompt=True 相当: prefix を表す先頭トークンも mean に寄与する。
        // ここでは token 0 を「prefix」として大きな値を入れ、最終的に
        // pooled[0] が prefix の影響を確かに受けることを assert する。
        let hidden = vec![10.0, 10.0, 0.0, 0.0, 0.0, 0.0];
        let mask = vec![1u32, 1, 1];
        let pooled = mean_pool_with_mask(&hidden, &mask, 2);
        // (10 + 0 + 0) / 3 ≈ 3.333 ≠ 0 → prefix が pooling に含まれている
        assert!(pooled[0] > 3.0 && pooled[0] < 4.0);
    }

    // ── l2_normalize_in_place ────────────────────────────────────────────

    #[test]
    fn l2_normalize_unit_vector_norm_is_one() {
        let mut v = vec![3.0f32, 4.0];
        l2_normalize_in_place(&mut v);
        let norm = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!(approx_eq(norm, 1.0, 1e-6));
        assert!(approx_eq(v[0], 0.6, 1e-6));
        assert!(approx_eq(v[1], 0.8, 1e-6));
    }

    #[test]
    fn l2_normalize_zero_vector_remains_zero() {
        let mut v = vec![0.0f32, 0.0, 0.0];
        l2_normalize_in_place(&mut v);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
    }

    #[test]
    fn l2_normalize_idempotent_on_unit_vectors() {
        let mut v = vec![0.6f32, 0.8];
        l2_normalize_in_place(&mut v);
        let snapshot = v.clone();
        l2_normalize_in_place(&mut v);
        assert!(approx_eq(v[0], snapshot[0], 1e-6));
        assert!(approx_eq(v[1], snapshot[1], 1e-6));
    }

    // ── cosine_similarity ────────────────────────────────────────────────

    #[test]
    fn cosine_identical_vectors_is_one() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![1.0f32, 2.0, 3.0];
        assert!(approx_eq(cosine_similarity(&a, &b), 1.0, 1e-6));
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        assert!(approx_eq(cosine_similarity(&a, &b), 0.0, 1e-6));
    }

    #[test]
    fn cosine_opposite_vectors_is_negative_one() {
        let a = vec![1.0f32, 2.0];
        let b = vec![-1.0f32, -2.0];
        assert!(approx_eq(cosine_similarity(&a, &b), -1.0, 1e-6));
    }

    #[test]
    fn cosine_zero_vector_returns_zero_not_nan() {
        let a = vec![0.0f32, 0.0];
        let b = vec![1.0f32, 1.0];
        let s = cosine_similarity(&a, &b);
        assert_eq!(s, 0.0);
        assert!(!s.is_nan());
    }

    #[test]
    fn cosine_l2_normalized_dot_product_equivalence() {
        // L2 正規化済み vectors のドット積はコサイン類似度に等しい。
        // ruri-v3 の出力は L2 正規化済みなので、検索時のスコアリングはドット積で OK。
        let mut a = vec![3.0f32, 4.0];
        let mut b = vec![1.0f32, 2.0];
        l2_normalize_in_place(&mut a);
        l2_normalize_in_place(&mut b);
        let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
        let cos = cosine_similarity(&a, &b);
        assert!(approx_eq(dot, cos, 1e-6));
    }

    // ── prefix の確認 ────────────────────────────────────────────────────

    #[test]
    fn query_prefix_is_search_query_jp() {
        // ruri-v3 の指定 prefix。spec §2.1 で確定。書き換えると検索精度が落ちる。
        assert_eq!(QUERY_PREFIX, "検索クエリ: ");
    }

    #[test]
    fn document_prefix_is_search_document_jp() {
        assert_eq!(DOCUMENT_PREFIX, "検索文書: ");
    }

    #[test]
    fn embedding_dim_30m_is_256() {
        assert_eq!(EMBEDDING_DIM_RURI_V3_30M, 256);
    }

    // ── cls_pool ─────────────────────────────────────────────────────────

    #[test]
    fn cls_pool_returns_first_token() {
        // seq_len=3, hidden_dim=2 → 先頭トークン [1,2] を返す。
        let hidden = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0];
        assert_eq!(cls_pool(&hidden, 2), vec![1.0, 2.0]);
    }

    // ── SPEC_JA ↔ legacy consts のドリフト防止 ───────────────────────────
    // spec.rs は `--no-default-features` でも build できるよう ja 値をリテラルで
    // 持つ。ここ (feature 内) で両者の一致を locks する。

    #[test]
    fn spec_ja_matches_legacy_consts() {
        use crate::spec::SPEC_JA;
        assert_eq!(SPEC_JA.model_id, MODEL_ID_RURI_V3_30M);
        assert_eq!(SPEC_JA.embedding_dim, EMBEDDING_DIM_RURI_V3_30M);
        assert_eq!(SPEC_JA.query_prefix, QUERY_PREFIX);
        assert_eq!(SPEC_JA.document_prefix, DOCUMENT_PREFIX);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Python golden 検証 (§2.2)。fixture + ONNX + tokenizer.json が揃っている
// ときだけ実行する gated test。CI/サンドボックスでは silent skip。
//
// fp32 ONNX (model.onnx) があれば 段階A として cosine >= 0.9999、
// 量子化 ONNX しか無ければ 段階B 相当として cosine >= 0.99 を gate にする。
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod golden {
    use super::{cosine_similarity, Embedder};
    use crate::spec::{EmbeddingModelSpec, Pooling, SPEC_EN, SPEC_JA};
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    struct GoldenDoc {
        embedding_dim: usize,
        query_prefix: String,
        document_prefix: String,
        /// schema_version 2 で追加。v1 fixture には無いので Option。
        #[serde(default)]
        pooling: Option<String>,
        samples: Vec<GoldenSample>,
    }

    #[derive(Deserialize)]
    struct GoldenSample {
        kind: String,
        text: String,
        // `prefix` は出力 JSON に含まれるが本 test ではフィールド存在のみで足りる
        #[allow(dead_code)]
        prefix: String,
        prefixed: String,
        embedding: Vec<f32>,
    }

    fn tauri_manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    fn pooling_label(p: Pooling) -> &'static str {
        match p {
            Pooling::MeanWithMask => "mean",
            Pooling::Cls => "cls",
        }
    }

    /// 存在する model ファイルを優先順 (fp32 → 量子化) に**全部** 返す。
    /// 各要素の `quantized` が true なら gate を緩めて評価する。
    fn locate_models(dir: &std::path::Path) -> Vec<(PathBuf, bool)> {
        let mut found = Vec::new();
        let candidates: &[(&str, bool)] = &[
            ("model.onnx", false),
            ("model_fp16.onnx", false),
            ("model_int8.onnx", true),
            ("model_quantized.onnx", true),
            ("model_uint8.onnx", true),
            ("model_q4.onnx", true),
        ];
        for (name, quantized) in candidates {
            let p = dir.join(name);
            if p.exists() {
                found.push((p, *quantized));
            }
        }
        found
    }

    /// 1 spec 分の fixture + ONNX を検証する。fixture/model が無ければ skip して
    /// 失敗 0 件で返す (CI/サンドボックスでは silent skip)。
    fn verify_spec(spec: &'static EmbeddingModelSpec) -> Vec<String> {
        let fixture = tauri_manifest_dir()
            .join("tests/fixtures")
            .join(spec.golden_fixture);
        let dir = tauri_manifest_dir()
            .join("resources/semantic")
            .join(spec.dir_name);
        let tokenizer = dir.join("tokenizer.json");
        let models = locate_models(&dir);

        if !fixture.exists() || !tokenizer.exists() || models.is_empty() {
            eprintln!(
                "[golden {}] skipped (fixture={} tokenizer={} models={})",
                spec.dir_name,
                fixture.exists(),
                tokenizer.exists(),
                models.len()
            );
            return Vec::new();
        }

        let raw = fs::read_to_string(&fixture).expect("read fixture");
        let golden: GoldenDoc = serde_json::from_str(&raw).expect("parse fixture");
        assert_eq!(
            golden.embedding_dim, spec.embedding_dim,
            "fixture dim != spec dim for {}; fixture and model out of sync",
            spec.dir_name
        );
        assert_eq!(golden.query_prefix, spec.query_prefix);
        assert_eq!(golden.document_prefix, spec.document_prefix);
        if let Some(p) = &golden.pooling {
            assert_eq!(
                p,
                pooling_label(spec.pooling),
                "fixture pooling != spec pooling for {}",
                spec.dir_name
            );
        }

        let mut failures: Vec<String> = Vec::new();
        for (model_path, is_quantized) in &models {
            let threshold: f32 = if *is_quantized { 0.99 } else { 0.9999 };
            let mut embedder = Embedder::load(model_path, &tokenizer, spec)
                .unwrap_or_else(|e| panic!("load Embedder for {model_path:?}: {e}"));
            let mut worst_cos: f32 = 1.0;
            for sample in &golden.samples {
                let actual = embedder
                    .embed_prefixed(&sample.prefixed)
                    .unwrap_or_else(|e| {
                        panic!(
                            "embed_prefixed failed for {:?} on {:?}: {e}",
                            sample.text, model_path
                        )
                    });
                assert_eq!(actual.len(), sample.embedding.len());
                let cos = cosine_similarity(&actual, &sample.embedding);
                worst_cos = worst_cos.min(cos);
                if cos < threshold {
                    failures.push(format!(
                        "model={model_path:?} kind={} text={:?} cos={cos} < {threshold}",
                        sample.kind, sample.text
                    ));
                }
            }
            eprintln!(
                "[golden {}] model={:?} quantized={} worst_cos={worst_cos} (>= {threshold})",
                spec.dir_name, model_path, is_quantized
            );
        }
        failures
    }

    #[test]
    fn rust_pipeline_matches_python_golden() {
        let mut failures = Vec::new();
        for spec in [&SPEC_JA, &SPEC_EN] {
            failures.extend(verify_spec(spec));
        }
        assert!(
            failures.is_empty(),
            "golden test failed for {} sample(s):\n{}",
            failures.len(),
            failures.join("\n")
        );
    }

    /// Regression: a chunk longer than the model's position table must be
    /// truncated, not crash ONNX. This reproduces "English project + Japanese
    /// text": each CJK ideograph is ~1 bge token, so a long Japanese passage
    /// tokenizes to >512 tokens and previously failed at `/embeddings/Add_1`
    /// ("Attempting to broadcast an axis ... 512 by 676"). Skipped when the bge
    /// model/tokenizer aren't present (CI/sandbox without resources).
    #[test]
    fn over_long_input_is_truncated_not_crashed() {
        let dir = tauri_manifest_dir()
            .join("resources/semantic")
            .join(SPEC_EN.dir_name);
        let tokenizer = dir.join("tokenizer.json");
        let models = locate_models(&dir);
        if !tokenizer.exists() || models.is_empty() {
            eprintln!(
                "[trunc {}] skipped (tokenizer={} models={})",
                SPEC_EN.dir_name,
                tokenizer.exists(),
                models.len()
            );
            return;
        }
        // ~700 CJK ideographs → ~700 bge tokens before truncation, well over 512.
        let long_input = "国".repeat(700);
        for (model_path, _) in &models {
            let mut embedder = Embedder::load(model_path, &tokenizer, &SPEC_EN)
                .unwrap_or_else(|e| panic!("load bge embedder {model_path:?}: {e}"));
            let pooled = embedder.embed_document(&long_input).unwrap_or_else(|e| {
                panic!("over-long input must be truncated, not crash, on {model_path:?}: {e}")
            });
            assert_eq!(
                pooled.len(),
                SPEC_EN.embedding_dim,
                "bge dim mismatch for {model_path:?}"
            );
        }
    }
}
