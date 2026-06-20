//! Grimodex deterministic text linter core.
//!
//! This crate is shared between the Tauri application and the standalone
//! `grimodex-mcp` binary. Diagnostics returned from [`lint`] use scene-wide
//! UTF-16 code-unit offsets regardless of caller.

#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing
)]

pub mod dialogue;
pub mod engine;
pub mod error;
pub mod morph;
pub mod offset;
pub mod rule;
pub mod rules;
pub mod stem;
pub mod textscan;

pub use dialogue::{analyze_dialogue, DialogueAnalysis, DialogueScope};
pub use engine::{lint, LintResponse, MAX_INPUT_BYTES};
pub use error::LintError;
pub use rule::{
    BlockKind, CodexEntry, Diagnostic, DisableDirective, Fix, Language, LintBlock, LintConfig,
    LintContext, LintInput, LintRule, LintScope, RuleConfig, RuleSelector, RuleWarning,
    SelectorKind, Severity, TermEntry, Utf16Range, WarningKind,
};
