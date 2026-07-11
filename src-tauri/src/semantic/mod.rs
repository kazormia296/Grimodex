//! Tauri semantic adapter.
//!
//! Indexing, search, chunking, embedding, preview, and model specifications
//! live in `grimodex-semantic`. Model download remains local because it owns
//! the Tauri `AppHandle` event/resource-directory lifecycle.

// Several paths are feature-gated consumers; retain the full compatibility
// surface in both feature configurations.
#[allow(unused_imports)]
pub(crate) use grimodex_semantic::{
    chat_index, chat_search, chunker, codex_index, codex_search, events_index, events_search,
    index, preview, search, spec,
};

// Kept as part of the pre-extraction module surface even though only the
// shared crate currently composes it directly.
#[allow(unused_imports)]
pub(crate) use grimodex_semantic::chunker_en;

#[cfg(feature = "semantic-embedding")]
pub(crate) use grimodex_semantic::embedding;

#[cfg(feature = "semantic-embedding")]
pub(crate) mod download;
