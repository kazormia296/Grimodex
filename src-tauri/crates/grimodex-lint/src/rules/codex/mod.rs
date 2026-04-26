//! Codex-linked lint rules (F-group).
//!
//! These rules consult `LintConfig.codex_entries` — the frontend is
//! expected to attach the relevant Codex subset on each lint request.

pub mod name_inconsistency;
