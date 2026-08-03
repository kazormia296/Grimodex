//! Tauri-independent semantic indexing and search core.
//!
//! The desktop shells own model download and IPC lifecycle concerns. This
//! crate owns deterministic chunking, embedding, database indexing, caches,
//! search, preview slicing, and model specifications.

pub mod audit;
pub mod chat_index;
pub mod chat_search;
pub mod chunker;
pub mod chunker_en;
pub mod codex_candidates;
pub mod codex_index;
pub mod codex_search;
pub mod events_index;
pub mod events_search;
pub mod index;
pub mod preview;
pub mod runtime;
pub mod search;
pub mod spec;

#[cfg(feature = "semantic-embedding")]
pub mod download;
#[cfg(feature = "semantic-embedding")]
pub mod embedding;
#[cfg(feature = "semantic-embedding")]
pub mod reranker;

#[cfg(test)]
mod audit_tests;
