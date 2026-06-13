//! Language-specific plain-text scanning primitives shared between the
//! deterministic linter and the semantic chunker (which lives in `src-tauri`
//! and depends on this crate).
//!
//! Everything here is pure logic over `&str`, depending only on `std` and
//! `regex`. All ranges returned are **UTF-8 byte ranges** within the input;
//! callers convert to UTF-16 via [`crate::offset::utf8_to_utf16`] when they
//! need scene-wide offsets.

pub mod en;
