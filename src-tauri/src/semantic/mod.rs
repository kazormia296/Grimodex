//! 本文セマンティック検索 (詳細: temp/semantic-prose-search-context.md)。
//!
//! MVP の責務分割:
//! - `chunker`: ProseMirror doc → 段落抽出・ビート分類・括弧対応文分割・パッキング。埋め込みに依存しない純ロジック。
//! - `embedding`: ort + tokenizers で ruri-v3 ONNX 推論。Embedder の load + embed_query/document と
//!   pure-logic helper (mean_pool, l2_normalize, cosine)。Python golden との一致検証は
//!   tests/embedding_golden.rs で gated に行う。
//! - `index`: scene_chunks DB upsert と content_hash race 検証 (Step 6)。
//!   pure 部分は feature 無しで build できる。`index_scene` のみ Embedder 経由のため
//!   `semantic-embedding` feature 内。
//! - `search`: in-memory cache + 総当たりコサイン + dialogue_ratio 減点 (Step 7、別セッションで追加予定)。

pub(crate) mod chat_index;
pub(crate) mod chat_search;
pub(crate) mod chunker;
pub(crate) mod chunker_en;
pub(crate) mod codex_index;
pub(crate) mod codex_search;
pub(crate) mod events_index;
pub(crate) mod events_search;
pub(crate) mod index;
pub(crate) mod preview;
pub(crate) mod search;
pub(crate) mod spec;

#[cfg(feature = "semantic-embedding")]
pub(crate) mod embedding;
