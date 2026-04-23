//! Error types returned from the public `lint()` entry point.

use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum LintError {
    #[error("text too large: {actual} bytes (max: {max})")]
    TextTooLarge { actual: usize, max: usize },

    #[error("invalid language: {0}")]
    InvalidLanguage(String),

    #[error("config parse error: {path}: {reason}")]
    InvalidConfig { path: String, reason: String },

    #[error("internal error: {0}")]
    Internal(String),
}
