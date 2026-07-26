//! Tauri semantic adapter.
//!
//! Indexing, search, chunking, embedding, model download, runtime lifecycle,
//! preview, and model specifications live in `grimodex-semantic`.

// Several paths are feature-gated consumers; retain the full compatibility
// surface in both feature configurations.
#[allow(unused_imports)]
pub(crate) use grimodex_semantic::{
    chat_index, chat_search, chunker, codex_index, codex_search, events_index, events_search,
    index, preview, runtime, search, spec,
};

// Kept as part of the pre-extraction module surface even though only the
// shared crate currently composes it directly.
#[allow(unused_imports)]
pub(crate) use grimodex_semantic::chunker_en;

#[cfg(feature = "semantic-embedding")]
#[allow(unused_imports)]
pub(crate) use grimodex_semantic::embedding;
