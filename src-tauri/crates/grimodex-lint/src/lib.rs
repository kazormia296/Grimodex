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

pub mod engine;
pub mod error;
pub mod offset;
pub mod rule;
pub mod rules;

pub use engine::{lint, LintResponse, MAX_INPUT_BYTES};
pub use error::LintError;
pub use rule::{
    BlockKind, Diagnostic, Fix, Language, LintBlock, LintConfig, LintContext, LintInput, LintRule,
    LintScope, RuleConfig, RuleWarning, Severity, Utf16Range, WarningKind,
};
